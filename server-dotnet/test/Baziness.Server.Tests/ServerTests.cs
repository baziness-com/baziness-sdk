using System.Text.Json;

namespace Baziness.Server.Tests;

/// <summary>The same behaviour <c>server-node/test/server.test.ts</c> pins down, on the same fake platform.</summary>
public class ServerTests(FakeHub hub) : IClassFixture<FakeHub>, IAsyncLifetime
{
    private static SignInRequest Device => new("device-1", BazinessPlatform.Web, BazinessStore.Direct);

    public async Task InitializeAsync() => await hub.Control("reset", new { });

    public Task DisposeAsync() => Task.CompletedTask;

    private Task<int> TokenCalls() => hub.Requests("/api/client/get-user-token/");

    private static string Key(JsonElement serverEvent) => serverEvent.GetProperty("eventKey").GetString()!;

    // ── Configuration ──

    [Fact]
    public void Refuses_a_missing_secret_and_an_unknown_environment()
    {
        var secret = Assert.Throws<ArgumentException>(() => new BazinessServer(new BazinessServerOptions
        {
            Environment = BazinessEnvironment.Staging, ClientId = 12, ClientSecret = " "
        }));
        Assert.Contains("clientSecret", secret.Message);

        var environment = Assert.Throws<ArgumentException>(() => BazinessServer.FromEnv(new Dictionary<string, string?>
        {
            ["BAZINESS_ENVIRONMENT"] = "dev", ["BAZINESS_CLIENT_ID"] = "12", ["BAZINESS_CLIENT_SECRET"] = "x"
        }));
        Assert.Contains("\"staging\" or \"production\"", environment.Message);

        Assert.Throws<ArgumentException>(() => new BazinessServer(new BazinessServerOptions
        {
            Environment = (BazinessEnvironment)99, ClientId = 12, ClientSecret = "x"
        }));
    }

    [Fact]
    public void Reads_the_environment_variables()
    {
        var baziness = BazinessServer.FromEnv(new Dictionary<string, string?>
        {
            ["BAZINESS_ENVIRONMENT"] = "production",
            ["BAZINESS_CLIENT_ID"] = "12",
            ["BAZINESS_CLIENT_SECRET"] = "secret"
        });

        Assert.Equal(BazinessEnvironment.Production, baziness.Environment);
        Assert.Equal("https://platform.karizmastudio.com/api", baziness.PublicConfig().ApiUrl);
        Assert.Equal("https://baziness.com", baziness.PublicConfig().PagesUrl);

        Assert.Throws<ArgumentException>(() => BazinessServer.FromEnv(new Dictionary<string, string?>
        {
            ["BAZINESS_CLIENT_ID"] = "not-a-number", ["BAZINESS_CLIENT_SECRET"] = "secret"
        }));
    }

    // ── Client auth ──

    [Fact]
    public async Task Authenticates_once_and_again_after_the_client_token_expires()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        await baziness.Coins.BalanceAsync(player.UserId);
        await hub.Control("expire-client-tokens", new { });

        Assert.Equal(0, await baziness.Coins.BalanceAsync(player.UserId));
        Assert.Equal(2, await hub.Requests("/api/client/auth"));
    }

    [Fact]
    public async Task Reports_a_wrong_secret_as_a_401()
    {
        var baziness = hub.Sdk(clientSecret: "wrong");

        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.BalanceAsync(1));

        Assert.Equal(401, error.Status);
    }

    [Fact]
    public async Task Sponsor_ads_use_client_auth_and_do_not_replay_uncertain_tracking()
    {
        await using var baziness = hub.Sdk();
        Assert.Null(await baziness.Ads.GetAsync());
        await hub.Control("ad", new { ad = (object?)null });
        Assert.Null(await baziness.Ads.GetAsync());
        var ad = new Ad(4294967297, "Sponsor", "https://example.test/ad.png", "https://example.test/");
        await hub.Control("ad", new { ad });
        Assert.Equal(ad, await baziness.Ads.GetAsync());
        await using var other = hub.OtherGame();
        Assert.Null(await other.Ads.GetAsync());
        await hub.Control("expire-client-tokens", new { });
        Assert.Equal(ad, await baziness.Ads.GetAsync());
        var player = await baziness.Players.SignInAsync(Device);
        await baziness.Ads.SeenAsync(ad.Id, player.UserId);
        await baziness.Ads.ClickAsync(ad.Id, player.UserId);
        var events = (await hub.State()).GetProperty("adEvents").EnumerateArray().ToList();
        Assert.Equal(2, events.Count);
        Assert.Equal(ad.Id, events[0].GetProperty("adId").GetInt64());
        Assert.Equal(player.UserId, events[0].GetProperty("userId").GetInt64());
        Assert.Equal("seen", events[0].GetProperty("eventType").GetString());
        Assert.Equal("click", events[1].GetProperty("eventType").GetString());
        await hub.Control("fail", new { path = "/api/content/ad-event", status = 500, times = 1 });
        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Ads.SeenAsync(ad.Id, player.UserId));
        Assert.Equal(500, error.Status);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => baziness.Ads.ClickAsync(ad.Id, 0));
        Assert.Equal(3, await hub.Requests("/api/content/ad-event"));
        await hub.Control("ad", new { ad = new { } });
        var malformed = await Assert.ThrowsAsync<BazinessException>(() => baziness.Ads.GetAsync());
        Assert.Equal("getAd", malformed.Operation);
    }

    // ── Players ──

    [Fact]
    public async Task Creates_a_player_on_first_sign_in_then_gets_their_long_lived_token_the_server_stores_none()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device with
        {
            Attribution = new Attribution { UtmSource = "instagram", CampaignCode = "spring" }
        });

        Assert.Equal(SignInMethod.Created, first.Method);
        Assert.False(first.IsLinkedToAccount);
        Assert.False(string.IsNullOrEmpty(first.AccessToken));
        Assert.True(first.AccessTokenExpiresAt > DateTimeOffset.UtcNow.AddDays(365), "a long-lived token");

        var attribution = (await hub.State()).GetProperty("users")[0].GetProperty("attribution");
        Assert.Equal("""{"utmSource":"instagram","linkCode":"spring"}""", attribution.GetRawText());

        // A fresh SDK instance (another server, or after a restart) has no cached token: it asks again.
        var second = await hub.Sdk().Players.SignInAsync(Device with { UserId = first.UserId });
        Assert.Equal(SignInMethod.Refresh, second.Method);
        Assert.Equal(first.UserId, second.UserId);
        Assert.Equal(1, await TokenCalls());
        Assert.Equal(0, await hub.Requests("/api/auth/") + await hub.Requests("/api/v2/client/create-user") + await hub.Requests("/api/v2/client/access-token/"));
    }

    [Fact]
    public async Task Serves_a_cached_token_while_it_has_time_left()
    {
        var baziness = hub.Sdk();
        var first = await baziness.Players.SignInAsync(Device);

        var again = await baziness.Players.SessionAsync(first.UserId);

        Assert.Equal(first.AccessToken, again.AccessToken);
        Assert.Equal(SignInMethod.Refresh, again.Method);
        Assert.Equal(0, await TokenCalls());
    }

    [Fact]
    public async Task Sign_in_sees_an_account_linked_since_the_token_was_cached()
    {
        var baziness = hub.Sdk();
        var first = await baziness.Players.SignInAsync(Device);
        Assert.False(first.IsLinkedToAccount);

        await hub.Control("phone-login", new { userId = first.UserId, phone = "09121234567" });
        var again = await baziness.Players.SignInAsync(Device with { UserId = first.UserId });

        Assert.True(again.IsLinkedToAccount);
    }

    [Fact]
    public async Task Sign_in_sees_an_account_blocked_since_the_token_was_cached()
    {
        var baziness = hub.Sdk();
        var first = await baziness.Players.SignInAsync(Device);

        await hub.Control("suspend", new { userId = first.UserId });

        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Players.SignInAsync(Device with { UserId = first.UserId }));
        Assert.Equal(BazinessErrorCodes.AccountSuspended, error.Code);
    }

    [Fact]
    public async Task Asks_once_when_several_requests_need_the_same_players_token_at_once()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device);
        var baziness = hub.Sdk();

        var results = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => baziness.Players.SessionAsync(first.UserId)));

        Assert.Single(results.Select(r => r.AccessToken).Distinct());
        Assert.Equal(1, await TokenCalls());
    }

    [Fact]
    public async Task Joins_a_player_who_arrives_with_a_link_code_to_the_same_person()
    {
        var yatzy = await hub.OtherGame().Players.SignInAsync(new SignInRequest("phone", BazinessPlatform.Android, BazinessStore.CafeBazaar));
        var code = (await hub.Control("link-code", new { userId = yatzy.UserId })).GetProperty("code").GetString();

        var fal = await hub.Sdk().Players.SignInAsync(Device with { LinkCode = code });

        Assert.Equal(SignInMethod.LinkCode, fal.Method);
        var users = (await hub.State()).GetProperty("users").EnumerateArray().ToList();
        long AccountOf(long id) => users.First(u => u.GetProperty("userId").GetInt64() == id).GetProperty("accountId").GetInt64();
        Assert.Equal(AccountOf(yatzy.UserId), AccountOf(fal.UserId));
    }

    [Fact]
    public async Task Continues_without_a_used_link_code()
    {
        var result = await hub.Sdk().Players.SignInAsync(Device with { LinkCode = "lc.expired" });

        Assert.Equal(SignInMethod.Created, result.Method);
        Assert.True(result.LinkCodeRejected);
    }

    [Fact]
    public async Task Keeps_a_known_player_when_their_link_code_is_stale()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device);

        var result = await hub.Sdk().Players.SignInAsync(Device with { UserId = first.UserId, LinkCode = "lc.used" });

        Assert.Equal(first.UserId, result.UserId);
        Assert.Equal(SignInMethod.Refresh, result.Method);
        Assert.True(result.LinkCodeRejected);
    }

    [Fact]
    public async Task Serves_two_server_instances_without_coordinating()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device);

        var both = await Task.WhenAll(hub.Sdk().Players.SessionAsync(first.UserId), hub.Sdk().Players.SessionAsync(first.UserId));

        Assert.All(both, session =>
        {
            Assert.Equal(first.UserId, session.UserId);
            Assert.Equal(SignInMethod.Refresh, session.Method);
        });
    }

    [Fact]
    public async Task Reports_a_suspended_account()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device);
        await hub.Control("suspend", new { userId = first.UserId });

        var error = await Assert.ThrowsAsync<BazinessException>(() => hub.Sdk().Players.SessionAsync(first.UserId));

        Assert.Equal(BazinessErrorCodes.AccountSuspended, error.Code);
        Assert.False(error.IsUnavailable);
    }

    [Fact]
    public async Task Verifies_a_page_token_and_tells_which_player_it_belongs_to()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        Assert.Equal(new VerifiedToken(true, player.UserId), await baziness.Players.VerifyTokenAsync(player.AccessToken));
        Assert.Equal(new VerifiedToken(false, 0), await baziness.Players.VerifyTokenAsync("forged"));
    }

    [Fact]
    public async Task Gives_a_link_code_per_page_and_logs_out()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        var first = await baziness.Players.LinkCodeAsync(player.UserId);
        var second = await baziness.Players.LinkCodeAsync(player.UserId);
        Assert.NotEqual(first.Code, second.Code);
        Assert.NotNull(first.ExpiresAt);

        // Logout forgets the cached token: the next session request asks the platform again.
        baziness.Players.Logout(player.UserId);
        var next = await baziness.Players.SessionAsync(player.UserId);
        Assert.NotEqual(player.AccessToken, next.AccessToken);
        Assert.Equal(1, await TokenCalls());
    }

    [Fact]
    public async Task Reads_a_players_campaign_matching_a_pending_install_by_the_device_the_server_saw()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(new SignInRequest("device-fp", BazinessPlatform.Android, BazinessStore.Direct));
        var pending = await baziness.Players.CampaignAsync(player.UserId);
        Assert.Equal("pending", pending.Status);
        Assert.True(pending.IsPending);

        await hub.Control("click", new { linkCode = "autumn", clickId = "c1", utmSource = "instagram", ip = "31.2.246.186" });
        var campaign = await baziness.Players.CampaignAsync(player.UserId, new DeviceFingerprint
        {
            Ip = " 31.2.246.186 ",
            UserAgent = "Mozilla/5.0 (Linux; Android 15; A142)",
            DeviceModel = "A142",
            OsVersion = "15"
        });

        Assert.True(campaign.Found);
        Assert.Equal("attributed", campaign.Status);
        Assert.Equal("probabilistic", campaign.MatchType);
        Assert.Equal("autumn", campaign.CampaignCode);
        Assert.Equal("c1", campaign.ClickId);
        Assert.Equal("instagram", campaign.UtmSource);
        Assert.NotNull(campaign.FirstSeen);
        Assert.False(campaign.IsPending);

        var seen = (await hub.State()).GetProperty("fingerprints").EnumerateArray().Last();
        Assert.Equal("server", seen.GetProperty("via").GetString());
        Assert.Equal("31.2.246.186", seen.GetProperty("ip").GetString());
        Assert.Equal("A142", seen.GetProperty("deviceModel").GetString());
        Assert.Equal("15", seen.GetProperty("osVersion").GetString());
    }

    [Fact]
    public async Task Answers_a_deterministic_campaign_as_it_is_and_refuses_another_games_player()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device with
        {
            Attribution = new Attribution { UtmSource = "telegram", CampaignCode = "tg" }
        });

        var campaign = await baziness.Players.CampaignAsync(player.UserId, new DeviceFingerprint { Ip = "127.0.0.1" });

        Assert.Equal("attributed", campaign.Status);
        Assert.Equal("deterministic", campaign.MatchType);
        Assert.Equal("tg", campaign.CampaignCode);
        var error = await Assert.ThrowsAsync<BazinessException>(() => hub.OtherGame().Players.CampaignAsync(player.UserId));
        Assert.Equal(403, error.Status);
    }

    [Fact]
    public async Task Finds_a_player_by_phone_number_only_among_its_own_players()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        Assert.Null(await baziness.Players.FindByPhoneAsync("09121234567"));

        await hub.Control("phone-login", new { userId = player.UserId, phone = "09121234567" });

        Assert.Equal(player.UserId, await baziness.Players.FindByPhoneAsync("09121234567"));
        Assert.Null(await hub.OtherGame().Players.FindByPhoneAsync("09121234567"));
    }

    [Fact]
    public async Task Reads_the_players_account_once_they_signed_in()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        Assert.Null(await baziness.Players.AccountDataAsync(player.UserId));

        await hub.Control("phone-login", new { userId = player.UserId, phone = "09121234567" });

        var account = await baziness.Players.AccountDataAsync(player.UserId);
        Assert.Equal("09121234567", account?.PhoneNumber);
        Assert.True(account?.AccountId > 0);
    }

    [Fact]
    public async Task Refuses_another_games_player()
    {
        var stranger = await hub.OtherGame().Players.SignInAsync(Device);

        var error = await Assert.ThrowsAsync<BazinessException>(() => hub.Sdk().Players.LinkCodeAsync(stranger.UserId));

        Assert.Equal(403, error.Status);
    }

    // ── Coins ──

    [Fact]
    public async Task Pays_a_grant_once_however_often_it_is_sent()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        var paid = await baziness.Coins.AddAsync(player.UserId, 50, "match:17");
        Assert.Equal(new AddCoinsResult(50, false, Coins.TransactionIdFor(player.UserId, 50, "match:17")), paid);
        await baziness.Coins.AddAsync(player.UserId, 20, "match:18", new { source = "match_win", matchId = 18 });

        // A later call for the same payout is refused, never paid twice.
        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.AddAsync(player.UserId, 50, "match:17"));
        Assert.Equal(BazinessErrorCodes.AddCoinRefused, error.Code);
        Assert.Equal(70, await baziness.Coins.BalanceAsync(player.UserId));
    }

    [Fact]
    public async Task Reports_a_payout_as_already_credited_when_its_answer_was_lost_and_the_retry_was_refused()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        await hub.Control("drop-after-credit", new { times = 1 });

        var paid = await baziness.Coins.AddAsync(player.UserId, 50, "match:17");

        Assert.Null(paid.Credited);
        Assert.True(paid.AlreadyCredited);
        Assert.Equal(50, await baziness.Coins.BalanceAsync(player.UserId));
    }

    [Fact]
    public async Task Refuses_a_payout_the_games_coin_wallet_cannot_cover_so_the_game_never_shows_unpaid_coins()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        await hub.Control("client-wallet", new { clientId = 12, balance = 130 });

        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.AddAsync(player.UserId, 500, "tutorial"));

        Assert.Equal(BazinessErrorCodes.AddCoinRefused, error.Code);
        Assert.Equal(0, await baziness.Coins.BalanceAsync(player.UserId));
        Assert.Equal(100, (await baziness.Coins.AddAsync(player.UserId, 100, "small")).Credited);
    }

    [Fact]
    public async Task Insists_on_an_idempotency_key()
    {
        var error = await Assert.ThrowsAsync<ArgumentException>(() => hub.Sdk().Coins.AddAsync(1, 5, ""));

        Assert.Contains("grantKey", error.Message);
    }

    [Fact]
    public void Matches_the_ids_of_the_node_and_java_sdks()
    {
        Assert.Equal("239236_50_dc3ee6230b3a94ce5764afe9", Coins.TransactionIdFor(239236, 50, "match:17"));
        Assert.Equal("78b6c864-1376-5500-8720-9e4a2e0f87a2", ServerAnalytics.StableEventId("purchase:cafebazaar:order-1"));
    }

    // ── Device data ──

    [Fact]
    public void Reads_the_device_sdks_json()
    {
        var device = DeviceInfo.FromJson("""{"model":"Pixel 8","screenWidth":1080,"unknown":true,"deviceType":"phone"}""");
        Assert.Equal("Pixel 8", device?.Model);
        Assert.Equal(1080, device?.ScreenWidth);
        Assert.Equal("phone", device?.DeviceType);

        Assert.Equal("tg", Attribution.FromJson("""{"utmSource":"tg"}""")?.UtmSource);

        Assert.Null(DeviceInfo.FromJson(null));
        Assert.Null(DeviceInfo.FromJson("not json"));
    }

    // ── Resilience ──

    [Fact]
    public async Task Retries_a_503_and_a_dropped_connection_on_idempotent_calls()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        var path = $"/api/client/get-coin/{player.UserId}";
        await hub.Control("fail", new { path, status = 503, times = 1 });
        await hub.Control("fail", new { path, status = 0, times = 1 });

        Assert.Equal(0, await baziness.Coins.BalanceAsync(player.UserId));
    }

    [Fact]
    public async Task Does_not_retry_a_create_after_a_500_it_may_have_happened()
    {
        await hub.Control("fail", new { path = "/api/client/create-user", status = 500, times = 1 });

        var error = await Assert.ThrowsAsync<BazinessException>(() => hub.Sdk().Players.SignInAsync(Device));

        Assert.Equal(500, error.Status);
        Assert.True(error.IsUnavailable);
    }

    [Fact]
    public async Task Opens_the_breaker_after_repeated_outages_and_fails_fast()
    {
        var baziness = hub.Sdk(http: new HttpOptions { RetryBaseMs = 1, MaxAttempts = 1, BreakerThreshold = 2, BreakerResetMs = 60000 });
        var player = await baziness.Players.SignInAsync(Device);
        await hub.Control("fail", new { path = $"/api/client/get-coin/{player.UserId}", status = 503, times = 5 });

        Assert.Equal(503, (await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.BalanceAsync(player.UserId))).Status);
        Assert.Equal(503, (await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.BalanceAsync(player.UserId))).Status);
        var open = await Assert.ThrowsAsync<BazinessException>(() => baziness.Coins.BalanceAsync(player.UserId));
        Assert.Contains("circuit open", open.Message);
    }

    [Fact]
    public async Task A_caller_can_cancel_without_failing_others_waiting_on_the_same_player()
    {
        var first = await hub.Sdk().Players.SignInAsync(Device);
        var baziness = hub.Sdk();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        var other = baziness.Players.SessionAsync(first.UserId);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => baziness.Players.SessionAsync(first.UserId, cancelled.Token));

        Assert.Equal(first.UserId, (await other).UserId);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => baziness.Coins.BalanceAsync(first.UserId, cancelled.Token));
    }

    // ── Purchases and analytics ──

    [Fact]
    public async Task Records_a_store_purchase_and_its_funnel_event_once()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        var purchase = new RecordPurchaseRequest
        {
            UserId = player.UserId,
            Amount = 49000,
            Gateway = PaymentGateway.CafeBazaar,
            OrderId = "order-1",
            Sku = "gems_100"
        };

        await baziness.Purchases.RecordAsync(purchase);
        await baziness.Purchases.RecordAsync(purchase);
        await baziness.Analytics.FlushAsync();

        var state = await hub.State();
        Assert.Equal(1, state.GetProperty("purchases").GetArrayLength());
        var completed = state.GetProperty("serverEvents").EnumerateArray().Where(e => Key(e) == "iap_purchase_completed").ToList();
        Assert.Equal(2, completed.Count); // sent twice ...
        Assert.Single(completed.Select(e => e.GetProperty("eventId").GetString()).Distinct()); // ... with one event id, so it counts once
        Assert.Equal(ServerAnalytics.StableEventId("purchase:cafebazaar:order-1"), completed[0].GetProperty("eventId").GetString());
        Assert.Equal(49000, completed[0].GetProperty("value").GetDouble());
    }

    [Fact]
    public async Task Records_a_Baziness_Pay_purchase_keyed_by_the_payment_token()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        await baziness.Purchases.RecordAsync(new RecordPurchaseRequest
        {
            UserId = player.UserId,
            Amount = 99000,
            Gateway = PaymentGateway.BazinessPay,
            OrderId = "pay-token-1",
            Provider = "zarinpal"
        });

        var recorded = (await hub.State()).GetProperty("purchases").EnumerateArray()
            .First(p => p.GetProperty("orderId").GetString() == "pay-token-1");
        Assert.Equal("baziness_pay", recorded.GetProperty("gateway").GetString());
        Assert.Equal("zarinpal", recorded.GetProperty("provider").GetString());
    }

    [Fact]
    public async Task Rejects_purchases_it_cannot_count()
    {
        var baziness = hub.Sdk();

        var provider = await Assert.ThrowsAsync<ArgumentException>(() => baziness.Purchases.RecordAsync(new RecordPurchaseRequest
        {
            UserId = 1, Amount = 10, Gateway = PaymentGateway.Direct, OrderId = "x"
        }));
        var gateway = await Assert.ThrowsAsync<ArgumentException>(() => baziness.Purchases.RecordAsync(new RecordPurchaseRequest
        {
            UserId = 1, Amount = 10, Gateway = (PaymentGateway)99, OrderId = "x"
        }));

        Assert.Contains("provider", provider.Message);
        Assert.Contains("gateway", gateway.Message);
    }

    [Fact]
    public async Task Reports_sign_ins_sessions_with_device_data_and_game_events_through_the_trusted_channel()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        var sessionId = baziness.Analytics.Sessions.Start(player.UserId, new SessionStartOptions
        {
            Device = new DeviceInfo { Model = "Pixel 8", Os = "Android", OsVersion = "15", ScreenWidth = 1080, ScreenHeight = 2400, Sdk = "unity" }
        });
        baziness.Analytics.LevelComplete(player.UserId, "7", 1200);
        baziness.Analytics.Sessions.End(player.UserId);
        Assert.False(baziness.Analytics.Track(player.UserId, "Bad Name"));
        await baziness.Analytics.FlushAsync();

        var events = await hub.ServerEvents();
        Assert.Equal(["auth_login", "session_start", "device_info", "level_complete", "session_end"], events.Select(Key));
        Assert.Equal("created", events[0].GetProperty("props").GetProperty("method").GetString());
        Assert.Equal("false", events[0].GetProperty("props").GetProperty("linked").GetString());
        var deviceInfo = events.First(e => Key(e) == "device_info");
        Assert.Equal("1080x2400", deviceInfo.GetProperty("props").GetProperty("screen").GetString());
        Assert.Equal(sessionId, deviceInfo.GetProperty("sessionId").GetString());
        var level = events.First(e => Key(e) == "level_complete");
        Assert.Equal("7", level.GetProperty("props").GetProperty("level").GetString());
        Assert.Equal(1200, level.GetProperty("value").GetDouble());
        Assert.Equal(sessionId, level.GetProperty("sessionId").GetString());
    }

    [Fact]
    public async Task Sends_one_event_per_method_with_the_names_the_other_sdks_use()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);
        var analytics = baziness.Analytics;
        var ad = new AdPlacement("tapsell", "shop", "rewarded");

        analytics.PurchaseStarted(player.UserId, "gems_100", 49000, PaymentGateway.BazinessPay);
        analytics.PurchaseFailed(player.UserId, "gems_100", PaymentGateway.BazinessPay, "cancelled");
        analytics.AdImpression(player.UserId, ad);
        analytics.AdRevenue(player.UserId, ad, 120);
        analytics.TutorialBegin(player.UserId, "one");
        analytics.TutorialComplete(player.UserId);
        analytics.LevelStart(player.UserId, "7");
        analytics.LevelFail(player.UserId, "7", 3, 95, "timeout");
        analytics.ResourceEarn(player.UserId, "gems", 30, source: "match");
        analytics.ResourceSpend(player.UserId, "gems", 10, "booster", "shop");
        await analytics.FlushAsync();

        var events = (await hub.ServerEvents()).Skip(1).ToList(); // after auth_login
        Assert.Equal(["iap_purchase_started", "iap_purchase_failed", "ad_impression", "ad_revenue", "tutorial_begin", "tutorial_complete",
            "level_start", "level_fail", "resource_earn", "resource_spend"], events.Select(Key));
        Assert.Equal("baziness_pay", events[0].GetProperty("props").GetProperty("gateway").GetString());
        Assert.Equal("95", events[7].GetProperty("props").GetProperty("duration_s").GetString());
        Assert.Equal("timeout", events[7].GetProperty("props").GetProperty("reason").GetString());
        Assert.Equal("match", events[8].GetProperty("props").GetProperty("source").GetString());
        Assert.Equal("shop", events[9].GetProperty("props").GetProperty("sink").GetString());
    }

    [Fact]
    public async Task Ensure_keeps_one_session_across_repeated_session_requests()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        var first = baziness.Analytics.Sessions.Ensure(player.UserId, new SessionStartOptions { Device = new DeviceInfo { Model = "x" } });
        Assert.Equal(first, baziness.Analytics.Sessions.Ensure(player.UserId));

        baziness.Analytics.Sessions.End(player.UserId);
        Assert.NotEqual(first, baziness.Analytics.Sessions.Ensure(player.UserId));
    }

    [Fact]
    public async Task Ends_an_activity_session_after_the_idle_timeout()
    {
        var baziness = hub.Sdk(analytics: new AnalyticsOptions { FlushIntervalMs = 60000, HeartbeatMs = 20, IdleTimeoutMs = 30 });
        var player = await baziness.Players.SignInAsync(Device);

        var id = baziness.Analytics.Sessions.Touch(player.UserId);
        Assert.Equal(id, baziness.Analytics.Sessions.Touch(player.UserId)); // activity within the timeout keeps the session
        await Task.Delay(300);

        Assert.Null(baziness.Analytics.Sessions.Current(player.UserId));
        await baziness.Analytics.FlushAsync();
        Assert.Contains(await hub.ServerEvents(), e => Key(e) == "session_end");
    }

    [Fact]
    public async Task Keeps_events_while_the_platform_is_unavailable_and_sends_them_later()
    {
        var baziness = hub.Sdk(http: new HttpOptions { RetryBaseMs = 1, MaxAttempts = 1, BreakerThreshold = 0 });
        var player = await baziness.Players.SignInAsync(Device);
        await hub.Control("fail", new { path = "/api/analytics/server-events/batch", status = 503, times = 1 });

        baziness.Analytics.TutorialComplete(player.UserId);
        await baziness.Analytics.FlushAsync();
        Assert.Equal(2, baziness.Analytics.Pending); // kept after the 503

        await baziness.CloseAsync(1000); // close sends the rest without waiting for the backoff
        Assert.Equal(0, baziness.Analytics.Pending);
        Assert.Contains(await hub.ServerEvents(), e => Key(e) == "tutorial_complete");

        Assert.False(baziness.Analytics.TutorialComplete(player.UserId)); // closed
        await baziness.DisposeAsync(); // and closing twice is fine
    }

    [Fact]
    public async Task Drops_events_when_analytics_is_disabled()
    {
        var baziness = hub.Sdk(analytics: new AnalyticsOptions { Enabled = false });
        var player = await baziness.Players.SignInAsync(Device);

        Assert.False(baziness.Analytics.TutorialBegin(player.UserId));
        Assert.Equal(0, baziness.Analytics.Pending);
    }

    [Fact]
    public async Task Reads_the_offer_for_a_player()
    {
        var baziness = hub.Sdk();
        Assert.Null(await baziness.Offers.GetAsync(42));

        await hub.Control("offer", new { playerId = 42, bundleId = 7 });

        Assert.Equal(7, await baziness.Offers.GetAsync(42));
    }

    [Fact]
    public async Task Advances_a_quest()
    {
        var baziness = hub.Sdk();
        var player = await baziness.Players.SignInAsync(Device);

        await baziness.Quests.ProgressAsync(player.UserId, "example/win", 2);

        var quest = (await hub.State()).GetProperty("quests")[0];
        Assert.Equal(player.UserId, quest.GetProperty("userId").GetInt64());
        Assert.Equal("example/win", quest.GetProperty("questEventName").GetString());
        Assert.Equal(2, quest.GetProperty("progressCount").GetInt32());
    }

    // ── Baziness Pay ──

    private async Task<string> Paid(long uid, string sku, string? status = null)
    {
        var answer = status == null
            ? await hub.Control("pay-payment", new { uid, sku })
            : await hub.Control("pay-payment", new { uid, sku, status });
        return answer.GetProperty("token").GetString()!;
    }

    [Fact]
    public async Task Finds_the_paid_payment_verifies_its_token_and_consumes_it_once()
    {
        var pay = hub.Sdk().Pay("com.example.game");
        Assert.Null(await pay.FindAsync(7, "gems_100"));

        var token = await Paid(7, "gems_100");
        var payment = await pay.FindAsync(7, "gems_100");

        Assert.Equal(token, payment?.Token);
        Assert.Equal(7, payment?.PlayerId);
        Assert.Equal(49000, payment?.Amount);
        Assert.True(await pay.VerifyAsync(7, "gems_100", token));
        Assert.False(await pay.VerifyAsync(8, "gems_100", token)); // another player
        Assert.True(await pay.ConsumeAsync(7, "gems_100"));
        Assert.False(await pay.ConsumeAsync(7, "gems_100")); // nothing left to consume
        Assert.False(await pay.VerifyAsync(7, "gems_100", token)); // consumed
    }

    [Fact]
    public async Task Refuses_another_token_while_a_payment_is_paid_though_Pay_alone_would_accept_it()
    {
        var pay = hub.Sdk().Pay("com.example.game");
        await Paid(7, "gems_100");

        Assert.False(await pay.VerifyAsync(7, "gems_100", "made-up-token"));
        Assert.False(await pay.VerifyAsync(7, "gems_100", ""));
    }

    [Fact]
    public async Task Lets_Pay_check_the_token_of_a_payment_the_gateway_did_not_report_back()
    {
        var pay = hub.Sdk().Pay("com.example.game");
        var token = await Paid(7, "gems_100", "ready");

        Assert.Null(await pay.FindAsync(7, "gems_100"));
        Assert.False(await pay.VerifyAsync(7, "gems_100", "other"));
        Assert.True(await pay.VerifyAsync(7, "gems_100", token));
        Assert.Equal(token, (await pay.FindAsync(7, "gems_100"))?.Token);
    }

    [Fact]
    public async Task A_consume_whose_answer_was_lost_still_counts_as_consumed()
    {
        var pay = hub.Sdk().Pay("com.example.game");
        await Paid(7, "gems_100");
        await hub.Control("drop-after-consume", new { times = 1 });

        Assert.True(await pay.ConsumeAsync(7, "gems_100"));
        Assert.Equal("consumed", (await hub.State()).GetProperty("payments")[0].GetProperty("status").GetString());
    }

    [Fact]
    public async Task Throws_for_an_app_Pay_does_not_know_and_needs_a_package_name()
    {
        var baziness = hub.Sdk();
        var missing = Assert.Throws<ArgumentException>(() => baziness.Pay(" "));
        Assert.Contains("packageName", missing.Message);

        var error = await Assert.ThrowsAsync<BazinessException>(() => baziness.Pay("com.unknown.game").FindAsync(7, "gems_100"));

        Assert.Equal("no_required_params", error.Code);
    }

    [Fact]
    public void Uses_the_environment_Pay_unless_overridden()
    {
        var production = new BazinessServer(new BazinessServerOptions
        {
            Environment = BazinessEnvironment.Production, ClientId = 12, ClientSecret = "x"
        });
        Assert.Equal("https://pay.baziness.com", production.PublicConfig().PayUrl);

        var own = BazinessServer.FromEnv(new Dictionary<string, string?>
        {
            ["BAZINESS_CLIENT_ID"] = "12",
            ["BAZINESS_CLIENT_SECRET"] = "x",
            ["BAZINESS_PAY_BASE_URL"] = "https://pay.example.com/"
        });
        Assert.Equal("https://pay.example.com", own.PublicConfig().PayUrl);
    }
}
