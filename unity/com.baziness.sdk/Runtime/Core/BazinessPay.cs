using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>A payment the player completed on the Baziness Pay checkout page and your game has not consumed yet.</summary>
    public sealed class BazinessPayment
    {
        /// <summary>Your player id (Pay's <c>uid</c>).</summary>
        public long PlayerId;
        public string Sku;
        /// <summary>The payment's token: send it to your server, which verifies it and grants the package once.</summary>
        public string Token;
        public string TransactionId;
        /// <summary>What the player paid, in Toman; 0 when Pay did not say.</summary>
        public long Amount;
        public string PackageTitle;
        /// <summary>The bank gateway behind the checkout (<c>zarinpal</c>, <c>tara</c>, <c>snappPay</c>, …).</summary>
        public string Gateway;
        public string SubmittedAt;
    }

    /// <summary>
    /// Baziness Pay, the web checkout for packages registered in Pay under your app's package name. The
    /// player pays on the checkout page in the browser; there is no store billing in the game.
    /// <list type="number">
    /// <item>The player taps a package: show your "complete the purchase" dialog and open the checkout page
    /// (<see cref="CheckoutUrl"/>; <c>BazinessSdk.OpenCheckoutAsync</c> opens it).</item>
    /// <item>Back in the game, the player taps "Complete purchase": <see cref="FindPayment"/>. Null means not
    /// paid yet: keep the dialog so they can try again.</item>
    /// <item>Send the payment's token to your server. It verifies it with the server SDK
    /// (<c>pay.verify</c>), grants the package once per token and consumes it (<c>pay.consume</c>).</item>
    /// </list>
    /// Your server reports each granted payment to Baziness like any purchase (<c>purchases.record</c>,
    /// gateway <c>baziness_pay</c>).
    /// </summary>
    public sealed class BazinessPay
    {
        /// <summary>Pay's answer when there is no such payment (not paid, not yet reported by the gateway, or consumed).</summary>
        private const string NotValid = "payment_is_not_valid";

        private readonly IHttp http;

        /// <param name="payBase">Baziness Pay's root, e.g. <c>https://pay.baziness.com</c>.</param>
        /// <param name="packageName">Your app in Baziness Pay (Pay's <c>pname</c>).</param>
        public BazinessPay(IHttp http, string payBase, string packageName)
        {
            if (string.IsNullOrEmpty(packageName)) throw new ArgumentException("packageName is required (your app in Baziness Pay)");
            this.http = http;
            PayBase = payBase.TrimEnd('/');
            PackageName = packageName;
        }

        public string PayBase { get; }
        public string PackageName { get; }

        /// <summary>The checkout page for this package.</summary>
        /// <param name="playerId">Your player id, the same one your server verifies the payment with.</param>
        public Task<string> CheckoutUrl(string sku, long playerId)
        {
            if (string.IsNullOrEmpty(sku)) throw new ArgumentException("sku is required");
            return Task.FromResult(PayBase + "/buy?sku=" + Uri.EscapeDataString(sku)
                                   + "&uid=" + playerId.ToString(CultureInfo.InvariantCulture)
                                   + "&pname=" + Uri.EscapeDataString(PackageName));
        }

        /// <summary>
        /// The player's paid, unconsumed payment for this package, or null when there is none yet (not paid,
        /// still on the bank's page, or already consumed). Throws <see cref="BackendException"/> when Pay
        /// cannot be reached (status 0) or the package name is not registered in Pay.
        /// </summary>
        public async Task<BazinessPayment> FindPayment(string sku, long playerId)
        {
            var body = MiniJson.Serialize(new Dictionary<string, object>
            {
                ["uid"] = playerId, ["sku"] = sku, ["pname"] = PackageName
            });
            var result = await http.Send("POST", PayBase + "/get_payment", body,
                new Dictionary<string, string> { ["Content-Type"] = "application/json" });
            if (!result.Ok) throw new BackendException("pay get_payment: HTTP " + result.Status, result.Status);
            Dictionary<string, object> answer;
            try
            {
                answer = MiniJson.Object(MiniJson.Deserialize(result.Body));
            }
            catch (FormatException)
            {
                throw new BackendException("pay get_payment: Baziness Pay sent invalid JSON", result.Status);
            }
            if (!MiniJson.Bool(answer, "success"))
            {
                var error = MiniJson.String(answer, "error");
                if (error == NotValid) return null;
                throw new BackendException("pay get_payment: Baziness Pay answered " + (error ?? "unexpected")
                    + (error == "no_required_params" ? " (is " + PackageName + " registered in Baziness Pay?)" : ""), result.Status);
            }
            var token = MiniJson.String(answer, "token");
            if (string.IsNullOrEmpty(token)) throw new BackendException("pay get_payment: a payment without a token", result.Status);
            return new BazinessPayment
            {
                PlayerId = answer.ContainsKey("uid") ? MiniJson.Long(answer, "uid") : playerId,
                Sku = MiniJson.String(answer, "sku") ?? sku,
                Token = token,
                TransactionId = MiniJson.String(answer, "transactionId"),
                Amount = MiniJson.Long(answer, "amount"),
                PackageTitle = MiniJson.String(answer, "packageTitle"),
                Gateway = MiniJson.String(answer, "gateway"),
                SubmittedAt = MiniJson.String(answer, "submittedAt")
            };
        }
    }
}
