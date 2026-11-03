using System.Globalization;
using System.Text.Json;

namespace Baziness.Server;

/// <summary><c>platform</c> of a player's device, as <c>create-user</c> takes it.</summary>
public enum BazinessPlatform
{
    Android,
    Ios,
    Web,
    Editor,
    Windows,
    Mac,
    Linux
}

/// <summary>Where the build was installed from. Web games use <see cref="Direct"/>.</summary>
public enum BazinessStore
{
    Direct,
    GooglePlay,
    AppStore,
    CafeBazaar,
    Myket
}

/// <summary>Payment gateway of a purchase the game server reports: every payment, Baziness Pay included.</summary>
public enum PaymentGateway
{
    BazinessPay,
    CafeBazaar,
    Myket,
    GooglePlay,
    AppStore,

    /// <summary>Your own gateway.</summary>
    Direct
}

internal static class PaymentGateways
{
    public static string WireName(PaymentGateway gateway) => gateway switch
    {
        PaymentGateway.BazinessPay => "baziness_pay",
        PaymentGateway.CafeBazaar => "cafebazaar",
        PaymentGateway.Myket => "myket",
        PaymentGateway.GooglePlay => "googleplay",
        PaymentGateway.AppStore => "appstore",
        PaymentGateway.Direct => "direct",
        _ => throw new ArgumentException($"purchases.record: unknown gateway \"{gateway}\"", nameof(gateway))
    };
}

/// <summary>
/// First-touch attribution, collected by the device SDK on first open (landing UTMs, campaign link, store
/// referrer) and forwarded by the game server when it creates the player.
/// </summary>
public sealed class Attribution
{
    public string? UtmSource { get; set; }
    public string? UtmMedium { get; set; }
    public string? UtmCampaign { get; set; }
    public string? UtmContent { get; set; }
    public string? UtmTerm { get; set; }

    /// <summary>Campaign link code (<c>bz_lc</c> on a Baziness campaign link). Not the sign-in link code.</summary>
    public string? CampaignCode { get; set; }

    /// <summary>Click id (<c>bz_click</c>) of that campaign link.</summary>
    public string? ClickId { get; set; }

    /// <summary>Raw install referrer (Google Play, Cafe Bazaar, Myket).</summary>
    public string? Referrer { get; set; }

    /// <summary>Android installer package, e.g. <c>com.farsitel.bazaar</c>.</summary>
    public string? Installer { get; set; }

    /// <summary>ISO time of the first landing.</summary>
    public string? LandedAt { get; set; }

    /// <summary>The device SDK's JSON, as your game's connection received it; null when there is none.</summary>
    public static Attribution? FromJson(string? json) => DeviceJson.Read<Attribution>(json);
}

/// <summary>
/// What the device SDK reports about the player's device. The game server forwards it with the session
/// start, so it reaches Baziness through the trusted channel.
/// </summary>
public sealed class DeviceInfo
{
    public string? DeviceId { get; set; }
    public string? Platform { get; set; }
    public string? Store { get; set; }
    public string? Model { get; set; }
    public string? Manufacturer { get; set; }

    /// <summary><c>phone</c>, <c>tablet</c>, <c>desktop</c>, <c>console</c> or <c>unknown</c>.</summary>
    public string? DeviceType { get; set; }

    public string? Os { get; set; }
    public string? OsVersion { get; set; }
    public string? AppVersion { get; set; }

    /// <summary><c>unity</c> or <c>web</c>.</summary>
    public string? Sdk { get; set; }

    public string? SdkVersion { get; set; }
    public string? Locale { get; set; }
    public string? Timezone { get; set; }
    public int? ScreenWidth { get; set; }
    public int? ScreenHeight { get; set; }
    public int? Dpi { get; set; }
    public int? MemoryMb { get; set; }
    public string? Browser { get; set; }
    public string? Installer { get; set; }
    public string? Network { get; set; }

    /// <summary>The device SDK's JSON, as your game's connection received it; null when there is none.</summary>
    public static DeviceInfo? FromJson(string? json) => DeviceJson.Read<DeviceInfo>(json);
}

internal static class DeviceJson
{
    public static T? Read<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json))
            return null;

        try
        {
            return JsonSerializer.Deserialize<T>(json, Transport.ReadOptions);
        }
        catch (JsonException)
        {
            // Comes from a device: a bad value must not fail a sign-in or a session.
            return null;
        }
    }
}

/// <summary>
/// The player's device as your server saw it, for fingerprint attribution: the IP and User-Agent of the
/// player's request (behind a proxy: the forwarded client IP), plus the model and OS version the device SDK
/// reports. Without an IP, nothing is matched.
/// </summary>
public sealed class DeviceFingerprint
{
    public string? Ip { get; set; }
    public string? UserAgent { get; set; }
    public string? DeviceModel { get; set; }
    public string? OsVersion { get; set; }
}

/// <summary>
/// The install's campaign as Baziness knows it. An install that came with no campaign (no campaign link, UTMs,
/// store referrer or APK campaign) is <c>pending</c> for 24 hours after its first open; asking with the device's
/// fingerprint during that time matches it to the campaign link click it most likely followed
/// (<c>probabilistic</c>). After that it is <c>organic</c>.
/// </summary>
public sealed class Campaign
{
    /// <summary>False: Baziness has nothing for this player yet (just created; ask again shortly).</summary>
    public bool Found { get; init; }

    /// <summary><c>pending</c>, <c>attributed</c>, <c>organic</c>, <c>legacy</c> or empty.</summary>
    public string Status { get; init; } = "";

    /// <summary><c>deterministic</c>: link, store referrer or APK campaign. <c>probabilistic</c>: matched by fingerprint.</summary>
    public string MatchType { get; init; } = "";

    public string Channel { get; init; } = "";
    public string UtmSource { get; init; } = "";
    public string UtmMedium { get; init; } = "";
    public string UtmCampaign { get; init; } = "";
    public string UtmContent { get; init; } = "";
    public string UtmTerm { get; init; } = "";

    /// <summary>Campaign link code (<c>bz_lc</c>).</summary>
    public string CampaignCode { get; init; } = "";

    public string ClickId { get; init; } = "";

    /// <summary><c>googleplay</c>, <c>cafebazaar</c>, <c>myket</c>, <c>direct</c> or empty.</summary>
    public string InstallStore { get; init; } = "";

    public DateTimeOffset? FirstSeen { get; init; }
    public DateTimeOffset? AttributedAt { get; init; }

    /// <summary>Still waiting for a campaign; the answer is final once this is false.</summary>
    public bool IsPending => Status == "pending";
}

/// <summary>A player's Baziness session as your game server hands it to the player's device.</summary>
/// <param name="UserId">The Baziness user id of this player (one per game install, joined into a person by Baziness).</param>
/// <param name="IsLinkedToAccount">True once the player signed in with a phone number, false while anonymous.</param>
/// <param name="AccessToken">The player's token (long-lived): the device uses it for its own Baziness calls.</param>
/// <param name="AccessTokenExpiresAt">When the token expires (years away; the device asks your server again after it).</param>
public record PlayerSession(long UserId, bool IsLinkedToAccount, string AccessToken, DateTimeOffset AccessTokenExpiresAt);

/// <summary>How <see cref="Players.SignInAsync"/> found the session.</summary>
public enum SignInMethod
{
    /// <summary>A new Baziness user was created for this device.</summary>
    Created,

    /// <summary>The player arrived with a link code (from the Baziness app or another game): same person.</summary>
    LinkCode,

    /// <summary>A known player got their token.</summary>
    Refresh
}

/// <summary>What <see cref="Players.SignInAsync"/> found.</summary>
/// <param name="UserId">The Baziness user id of this player.</param>
/// <param name="IsLinkedToAccount">True once the player signed in with a phone number, false while anonymous.</param>
/// <param name="AccessToken">The player's token (long-lived).</param>
/// <param name="AccessTokenExpiresAt">When the token expires.</param>
/// <param name="Method">How the session was found.</param>
/// <param name="LinkCodeRejected">A link code was sent but had expired or was already used; the player continued without it.</param>
public sealed record SignInResult(
    long UserId,
    bool IsLinkedToAccount,
    string AccessToken,
    DateTimeOffset AccessTokenExpiresAt,
    SignInMethod Method,
    bool LinkCodeRejected)
    : PlayerSession(UserId, IsLinkedToAccount, AccessToken, AccessTokenExpiresAt);

/// <summary>Input of <see cref="Players.SignInAsync"/>: who the device is and what it arrived with.</summary>
/// <param name="DeviceId">Your stable id for this install (the device id your game generated on first launch).</param>
/// <param name="Platform">The player's device.</param>
/// <param name="Store">Where the build was installed from.</param>
public sealed record SignInRequest(string DeviceId, BazinessPlatform Platform, BazinessStore Store)
{
    /// <summary>The Baziness user id you already saved for this player, if any.</summary>
    public long? UserId { get; init; }

    /// <summary>One-time code the player arrived with (<c>?linkCode=</c> / deep link): joins them to that person.</summary>
    public string? LinkCode { get; init; }

    /// <summary>First-open attribution from the device SDK.</summary>
    public Attribution? Attribution { get; init; }
}

/// <param name="Code">Put it on the page address as <c>linkCode=</c>. Works once, for about two minutes.</param>
/// <param name="ExpiresAt">When the code stops working.</param>
public sealed record LinkCode(string Code, DateTimeOffset? ExpiresAt);

/// <param name="Valid">Whether the token is valid.</param>
/// <param name="UserId">The Baziness user the token belongs to; 0 when not valid.</param>
public sealed record VerifiedToken(bool Valid, long UserId);

/// <summary>The player's Baziness account.</summary>
public sealed record AccountData(long AccountId, string PhoneNumber, string FullName, string NationalCode, bool IsActive);

internal static class PlatformTime
{
    public static string ToIso(DateTimeOffset time) =>
        time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static DateTimeOffset? Parse(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time) ? time : null;
}
