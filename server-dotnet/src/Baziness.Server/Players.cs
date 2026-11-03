namespace Baziness.Server;

/// <summary>
/// Steps 2 and 3 of the flow: Baziness users for your players, their tokens, link codes for Baziness pages, and
/// verifying tokens that come back from a page. Your server stores no token: its client secret is enough to get
/// any of its players' tokens (<c>client/get-user-token</c>), and the SDK keeps them in memory.
/// </summary>
public sealed class Players
{
    /// <summary>Hand a cached token out only while it has at least this long left.</summary>
    private static readonly TimeSpan MinTokenLife = TimeSpan.FromMinutes(1);

    /// <summary>When a token's expiry can't be read: player tokens live for years.</summary>
    private static readonly TimeSpan LongLivedFallback = TimeSpan.FromDays(365);

    private const int MaxCachedSessions = 10000;

    private readonly Transport _transport;
    private readonly ServerAnalytics _analytics;
    private readonly IBazinessLogger _logger;
    private readonly object _gate = new();
    private readonly Dictionary<long, LinkedListNode<PlayerSession>> _cache = new();
    private readonly LinkedList<PlayerSession> _cacheOrder = new();
    private readonly Dictionary<long, Task<SignInResult>> _inFlight = new();

    internal Players(Transport transport, ServerAnalytics analytics, IBazinessLogger logger)
    {
        _transport = transport;
        _analytics = analytics;
        _logger = logger;
    }

    // ── High level: what a game server calls ────────────────────────────────────

    /// <summary>
    /// The one call for "a player's device came online". Creates the Baziness user the first time (or when the
    /// player arrived with a link code), otherwise gets the player's token. Reports <c>auth_login</c> when a user
    /// was created or joined through a link code. Asks the platform every time: what comes back also says whether
    /// the player has linked an account or been blocked since, which the token staying valid does not show.
    /// <para>
    /// Compare the returned user id with the one you saved: when it belongs to another of your players, it is the
    /// same person on another device, so switch this device to that player.
    /// </para>
    /// </summary>
    public async Task<SignInResult> SignInAsync(SignInRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var hasLinkCode = !string.IsNullOrEmpty(request.LinkCode);
        var isKnown = request.UserId is > 0;
        var linkCodeRejected = false;

        if (hasLinkCode || !isKnown)
        {
            try
            {
                var session = await CreateAsync(request, cancellationToken).ConfigureAwait(false);
                return Keep(session, hasLinkCode ? SignInMethod.LinkCode : SignInMethod.Created, false);
            }
            catch (BazinessException e) when (hasLinkCode && e.Code == BazinessErrorCodes.InvalidLinkCode)
            {
                // Expired, already used or meant for another game: carry on as if no code was sent.
                linkCodeRejected = true;
                _logger.Info("[baziness] link code rejected; continuing without it");
            }

            if (!isKnown)
            {
                var session = await CreateAsync(request with { LinkCode = null }, cancellationToken).ConfigureAwait(false);
                return Keep(session, SignInMethod.Created, true);
            }
        }

        var result = await FetchAsync(request.UserId!.Value, cancellationToken).ConfigureAwait(false);
        return result with { LinkCodeRejected = linkCodeRejected };
    }

    /// <summary>
    /// The token of a known player: the cached one, otherwise the platform's (one request at a time per player).
    /// Throws <see cref="BazinessException"/> <c>account_suspended</c> (403) for a blocked account.
    /// </summary>
    public async Task<SignInResult> SessionAsync(long userId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (_cache.TryGetValue(userId, out var node) && node.Value.AccessTokenExpiresAt - DateTimeOffset.UtcNow > MinTokenLife)
            {
                var cached = node.Value;
                return new SignInResult(cached.UserId, cached.IsLinkedToAccount, cached.AccessToken,
                    cached.AccessTokenExpiresAt, SignInMethod.Refresh, false);
            }
        }

        return await FetchAsync(userId, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>A link code for opening a Baziness page as this player. Get a new one for every page.</summary>
    public async Task<LinkCode> LinkCodeAsync(long userId, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<WireLinkCode>(
            new RequestSpec("linkCode", HttpMethod.Post, $"/v2/client/link-code/{userId}") { Idempotent = true },
            cancellationToken: cancellationToken).ConfigureAwait(false);

        if (string.IsNullOrEmpty(answer?.Code))
            throw new BazinessException("linkCode: the platform sent no code", "linkCode", 200);

        return new LinkCode(answer.Code, PlatformTime.Parse(answer.ExpiresAt));
    }

    /// <summary>
    /// Check a token that came from a device (the <c>login</c> message of a Baziness page) before acting on it.
    /// Invalid or expired tokens give <c>Valid = false, UserId = 0</c>, not an error.
    /// </summary>
    public async Task<VerifiedToken> VerifyTokenAsync(string token, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<WireValidateToken>(
            new RequestSpec("verifyToken", HttpMethod.Post, "/client/validate-user-token")
            {
                Body = new { token },
                Idempotent = true
            }, cancellationToken: cancellationToken).ConfigureAwait(false);

        var valid = answer is { IsValid: true, UserId: > 0 };
        return new VerifiedToken(valid, valid ? answer!.UserId : 0);
    }

    /// <summary>The page sent <c>logout</c>: forget the player's cached token.</summary>
    public void Logout(long userId)
    {
        lock (_gate)
        {
            if (_cache.Remove(userId, out var node))
                _cacheOrder.Remove(node);
        }
    }

    /// <summary>
    /// The Baziness user id of your player who signed in with this phone number, or null when none of your players
    /// did (for example to reward a phone number a campaign or partner sends you).
    /// </summary>
    public async Task<long?> FindByPhoneAsync(string phoneNumber, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(phoneNumber))
            throw new ArgumentException("players.findByPhone: phoneNumber is required", nameof(phoneNumber));

        var answer = await _transport.RequestAsync<WirePhoneDetail>(
            new RequestSpec("checkPhoneNumber", HttpMethod.Get, $"/client/check-phone-number/{Uri.EscapeDataString(phoneNumber.Trim())}")
            {
                Idempotent = true
            }, cancellationToken: cancellationToken).ConfigureAwait(false);

        return answer is { IsRegistered: true, UserId: > 0 } ? answer.UserId : null;
    }

    /// <summary>
    /// Your player's install campaign. Pass the device as your server saw it: while the install is still pending
    /// (24 h after its first open, when it came with no campaign) Baziness first matches it by that fingerprint to
    /// the campaign link click it most likely followed. Ask when the player opens the game; the answer is final
    /// once its status is no longer <c>pending</c>.
    /// </summary>
    public async Task<Campaign> CampaignAsync(long userId, DeviceFingerprint? device = null, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<WireCampaign>(
            new RequestSpec("campaign", HttpMethod.Post, $"/v2/client/attribution/{userId}")
            {
                Body = new
                {
                    ip = NullIfEmpty(device?.Ip?.Trim()),
                    userAgent = NullIfEmpty(device?.UserAgent),
                    deviceModel = NullIfEmpty(device?.DeviceModel?.Trim()),
                    osVersion = NullIfEmpty(device?.OsVersion?.Trim())
                },
                // Asking again answers the same: a click wins one install, and the first answer is final.
                Idempotent = true
            }, cancellationToken: cancellationToken).ConfigureAwait(false);

        return new Campaign
        {
            Found = answer?.Found == true,
            Status = answer?.Status ?? "",
            MatchType = answer?.MatchType ?? "",
            Channel = answer?.Channel ?? "",
            UtmSource = answer?.UtmSource ?? "",
            UtmMedium = answer?.UtmMedium ?? "",
            UtmCampaign = answer?.UtmCampaign ?? "",
            UtmContent = answer?.UtmContent ?? "",
            UtmTerm = answer?.UtmTerm ?? "",
            CampaignCode = answer?.LinkCode ?? "",
            ClickId = answer?.ClickId ?? "",
            InstallStore = answer?.InstallStore ?? "",
            FirstSeen = PlatformTime.Parse(answer?.FirstSeen),
            AttributedAt = PlatformTime.Parse(answer?.AttributedAt)
        };
    }

    /// <summary>The player's Baziness account (phone, name), or null when they have not signed in.</summary>
    public Task<AccountData?> AccountDataAsync(long userId, CancellationToken cancellationToken = default)
    {
        return _transport.RequestAsync<AccountData>(
            new RequestSpec("accountData", HttpMethod.Get, $"/client/account-data/{userId}") { Idempotent = true },
            cancellationToken: cancellationToken);
    }

    // ── Low level: one platform call each ─────────────────────────────────────────

    /// <summary>
    /// <c>client/create-user</c>: a new Baziness user for this install, or, with a link code, the user of the person
    /// it stands for in your game. Answers the player's token.
    /// </summary>
    public async Task<PlayerSession> CreateAsync(SignInRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(request.DeviceId))
            throw new ArgumentException("players.create: deviceId is required", nameof(request));

        var answer = await _transport.RequestAsync<WireUserAuth>(new RequestSpec("createUser", HttpMethod.Post, "/client/create-user")
        {
            Body = new
            {
                deviceId = request.DeviceId,
                platform = request.Platform.ToString(),
                store = request.Store.ToString(),
                linkCode = NullIfEmpty(request.LinkCode),
                attribution = ToWireAttribution(request.Attribution)
            },
            // A retried create could consume the link code twice or create a second user.
            Idempotent = false
        }, cancellationToken: cancellationToken).ConfigureAwait(false);

        return FromUserAuth(answer, "createUser");
    }

    /// <summary><c>client/get-user-token/{id}</c>: the token of one of your players.</summary>
    public async Task<PlayerSession> TokenAsync(long userId, CancellationToken cancellationToken = default)
    {
        var answer = await _transport.RequestAsync<WireUserAuth>(
            new RequestSpec("userToken", HttpMethod.Get, $"/client/get-user-token/{userId}") { Idempotent = true },
            cancellationToken: cancellationToken).ConfigureAwait(false);

        return FromUserAuth(answer, "userToken");
    }

    // ── Internals ─────────────────────────────────────────────────────────────────

    /// <summary>The platform's answer for a known player, one request at a time per player.</summary>
    private Task<SignInResult> FetchAsync(long userId, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            // Shared, so one caller giving up does not fail the others; each waits only as long as it wants.
            if (!_inFlight.TryGetValue(userId, out var pending))
            {
                pending = Task.Run(() => FetchSharedAsync(userId));
                _inFlight[userId] = pending;
            }

            return pending.WaitAsync(cancellationToken);
        }
    }

    private async Task<SignInResult> FetchSharedAsync(long userId)
    {
        try
        {
            return Keep(await TokenAsync(userId).ConfigureAwait(false), SignInMethod.Refresh, false);
        }
        finally
        {
            lock (_gate)
                _inFlight.Remove(userId);
        }
    }

    private SignInResult Keep(PlayerSession session, SignInMethod method, bool linkCodeRejected)
    {
        var kept = new PlayerSession(session.UserId, session.IsLinkedToAccount, session.AccessToken, session.AccessTokenExpiresAt);
        Remember(kept);

        if (method != SignInMethod.Refresh)
        {
            _analytics.Track(session.UserId, "auth_login", new TrackOptions
            {
                Props = new Dictionary<string, object?>
                {
                    ["method"] = method == SignInMethod.LinkCode ? "link_code" : "created",
                    ["linked"] = session.IsLinkedToAccount,
                    ["link_code_rejected"] = linkCodeRejected ? true : null
                }
            });
        }

        return new SignInResult(kept.UserId, kept.IsLinkedToAccount, kept.AccessToken, kept.AccessTokenExpiresAt, method, linkCodeRejected);
    }

    private void Remember(PlayerSession session)
    {
        lock (_gate)
        {
            if (_cache.Remove(session.UserId, out var existing))
                _cacheOrder.Remove(existing);

            _cache[session.UserId] = _cacheOrder.AddLast(session);

            if (_cache.Count > MaxCachedSessions)
            {
                var oldest = _cacheOrder.First!;
                _cacheOrder.RemoveFirst();
                _cache.Remove(oldest.Value.UserId);
            }
        }
    }

    private static PlayerSession FromUserAuth(WireUserAuth? answer, string operation)
    {
        if (answer == null || string.IsNullOrEmpty(answer.Token))
            throw new BazinessException($"{operation}: the platform sent no token", operation, 200);

        return new PlayerSession(answer.UserId, answer.IsLinkedToAccount, answer.Token,
            Jwt.Expiry(answer.Token) ?? DateTimeOffset.UtcNow + LongLivedFallback);
    }

    private static Dictionary<string, string>? ToWireAttribution(Attribution? attribution)
    {
        if (attribution == null)
            return null;

        var wire = new Dictionary<string, string?>
        {
            ["utmSource"] = attribution.UtmSource,
            ["utmMedium"] = attribution.UtmMedium,
            ["utmCampaign"] = attribution.UtmCampaign,
            ["utmContent"] = attribution.UtmContent,
            ["utmTerm"] = attribution.UtmTerm,
            ["linkCode"] = attribution.CampaignCode,
            ["clickId"] = attribution.ClickId,
            ["referrer"] = attribution.Referrer,
            ["installer"] = attribution.Installer,
            ["landedAt"] = attribution.LandedAt
        }.Where(field => !string.IsNullOrEmpty(field.Value)).ToDictionary(field => field.Key, field => field.Value!);

        return wire.Count > 0 ? wire : null;
    }

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

    private sealed record WireUserAuth(long UserId, string? Token, bool IsLinkedToAccount);

    private sealed record WireLinkCode(string? Code, string? ExpiresAt);

    private sealed record WireValidateToken(long UserId, bool IsValid);

    private sealed record WirePhoneDetail(bool IsRegistered, long? UserId);

    private sealed record WireCampaign(
        bool Found,
        string? Status,
        string? MatchType,
        string? Channel,
        string? UtmSource,
        string? UtmMedium,
        string? UtmCampaign,
        string? UtmContent,
        string? UtmTerm,
        string? LinkCode,
        string? ClickId,
        string? InstallStore,
        string? FirstSeen,
        string? AttributedAt);
}
