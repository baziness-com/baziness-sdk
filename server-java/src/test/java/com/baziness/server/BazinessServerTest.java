package com.baziness.server;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs the SDK against the shared fake hub ({@code tools/fake-hub}), the same one the Node SDK's
 * tests use. No test framework: {@code java ... BazinessServerTest} exits non-zero on a failure.
 */
public final class BazinessServerTest {
    private static String controlBase;
    private static String apiBase;
    private static String payBase;
    private static int passed;
    private static final List<String> failures = new ArrayList<String>();

    interface Check {
        void run() throws Exception;
    }

    public static void main(String[] args) throws Exception {
        Process hub = startFakeHub();
        try {
            test("parity with the Node SDK (ids)", () -> {
                equal(Coins.transactionIdFor(239236, 50, "match:17"), "239236_50_dc3ee6230b3a94ce5764afe9");
                equal(ServerAnalytics.stableEventId("purchase:cafebazaar:order-1"), "78b6c864-1376-5500-8720-9e4a2e0f87a2");
            });
            test("reads the device SDK's JSON", () -> {
                DeviceInfo device = DeviceInfo.fromJson("{\"model\":\"Pixel 8\",\"screenWidth\":1080,\"screenHeight\":2400}");
                equal(device.model, "Pixel 8");
                equal(device.toProps().get("screen"), "1080x2400");
                equal(Attribution.fromJson("{\"utmSource\":\"fal\",\"campaignCode\":\"c1\"}").toWire().get("linkCode"), "c1");
                check(Attribution.fromJson("not json").toWire() == null, "invalid JSON gives an empty attribution");
            });
            test("JSON round trip", () -> {
                Map<String, Object> value = Json.object(Json.parse("{\"a\":[1,2.5,true,null],\"b\":\"x\\\"\\u00e9\"}"));
                equal(Json.write(value), "{\"a\":[1,2.5,true,null],\"b\":\"x\\\"é\"}");
            });
            test("creates a player, then gets their long-lived token; the server stores none", () -> {
                Attribution attribution = new Attribution();
                attribution.utmSource = "instagram";
                attribution.campaignCode = "spring";
                SignInResult first = sdk().players().signIn(
                        new SignInRequest("phone-1", "Android", "CafeBazaar").attribution(attribution));
                equal(first.method, SignInResult.Method.CREATED);
                check(first.accessToken != null && first.accessTokenExpiresAt != null, "a token");
                check(java.time.Instant.parse(first.accessTokenExpiresAt)
                        .isAfter(java.time.Instant.now().plus(java.time.Duration.ofDays(365))), "a long-lived token");
                Map<String, Object> user = Json.object(users().get(0));
                equal(Json.write(user.get("attribution")), "{\"utmSource\":\"instagram\",\"linkCode\":\"spring\"}");

                // A fresh SDK (another server, or after a restart) has no cached token: it asks again.
                SignInResult second = sdk().players().signIn(
                        new SignInRequest("phone-1", "Android", "CafeBazaar").userId(first.userId));
                equal(second.method, SignInResult.Method.REFRESH);
                equal(second.userId, first.userId);
                equal(requests("/api/client/get-user-token/"), 1);
                equal(requests("/api/auth/") + requests("/api/v2/client/create-user")
                        + requests("/api/v2/client/access-token/"), 0);
            });
            test("sign-in sees an account linked or blocked since the token was cached", () -> {
                BazinessServer baziness = sdk();
                SignInResult first = baziness.players().signIn(new SignInRequest("phone-1", "Android", "CafeBazaar"));
                check(!first.isLinkedToAccount, "anonymous at first");
                control("phone-login", "{\"userId\":" + first.userId + ",\"phone\":\"09121234567\"}");
                SignInResult again = baziness.players().signIn(
                        new SignInRequest("phone-1", "Android", "CafeBazaar").userId(first.userId));
                check(again.isLinkedToAccount, "linked since");
                control("suspend", "{\"userId\":" + first.userId + "}");
                boolean reported = false;
                try {
                    baziness.players().signIn(new SignInRequest("phone-1", "Android", "CafeBazaar").userId(first.userId));
                } catch (BazinessException e) {
                    reported = e.hasCode(BazinessException.ACCOUNT_SUSPENDED);
                }
                check(reported, "a blocked account is reported");
            });
            test("joins a player arriving with a link code to the same person", () -> {
                BazinessServer yatzy = sdk(13, "fake-client-secret-13");
                SignInResult yatzyPlayer = yatzy.players().signIn(new SignInRequest("phone", "Android", "CafeBazaar"));
                String code = Json.string(Json.object(control("link-code", "{\"userId\":" + yatzyPlayer.userId + "}")), "code");
                SignInResult falPlayer = sdk().players().signIn(
                        new SignInRequest("browser", "Web", "Direct").linkCode(code));
                equal(falPlayer.method, SignInResult.Method.LINK_CODE);
                equal(accountOf(falPlayer.userId), accountOf(yatzyPlayer.userId));
                check(accountOf(falPlayer.userId) != null, "joined into one account");
            });
            test("continues without a used link code", () -> {
                SignInResult result = sdk().players().signIn(
                        new SignInRequest("d", "Web", "Direct").linkCode("lc.used"));
                equal(result.method, SignInResult.Method.CREATED);
                check(result.linkCodeRejected, "linkCodeRejected");
            });
            test("logout forgets the cached token; suspended account is reported", () -> {
                BazinessServer baziness = sdk();
                SignInResult player = baziness.players().signIn(new SignInRequest("d", "Web", "Direct"));
                baziness.players().logout(player.userId);
                baziness.players().session(player.userId);
                equal(requests("/api/client/get-user-token/"), 1);
                control("suspend", "{\"userId\":" + player.userId + "}");
                try {
                    sdk().players().session(player.userId);
                    check(false, "suspended account must throw");
                } catch (BazinessException e) {
                    equal(e.code(), "account_suspended");
                }
            });
            test("verifies a page token, gives link codes and logs out", () -> {
                BazinessServer baziness = sdk();
                SignInResult player = baziness.players().signIn(new SignInRequest("d", "Web", "Direct"));
                Players.VerifiedToken verified = baziness.players().verifyToken(player.accessToken);
                check(verified.valid && verified.userId == player.userId, "page token verified");
                check(!baziness.players().verifyToken("forged").valid, "forged token refused");
                check(!baziness.players().linkCode(player.userId).code.equals(baziness.players().linkCode(player.userId).code),
                        "a new code per page");
                baziness.players().logout(player.userId);
                check(!baziness.players().session(player.userId).accessToken.equals(player.accessToken),
                        "after logout the next session asks the platform again");
            });
            test("finds a player by phone number and reads the player's offer", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("d", "Android", "CafeBazaar")).userId;
                equal(baziness.players().findByPhone("09121234567"), 0L);
                control("phone-login", "{\"userId\":" + userId + ",\"phone\":\"09121234567\"}");
                equal(baziness.players().findByPhone("09121234567"), userId);
                equal(sdk(13, "fake-client-secret-13").players().findByPhone("09121234567"), 0L);

                check(baziness.offers().get(42) == null, "no offer yet");
                control("offer", "{\"playerId\":42,\"bundleId\":7}");
                equal(baziness.offers().get(42), 7);
            });
            test("ads use client auth, return no ad, and track full-width ids without replaying failures", () -> {
                BazinessServer baziness = sdk();
                check(baziness.ads().get() == null, "204 means no ad");
                control("ad", "{\"ad\":null}");
                check(baziness.ads().get() == null, "JSON null means no ad");
                control("ad", "{\"ad\":{\"id\":4294967297,\"title\":\"Sponsor\",\"imageUrl\":\"https://example.test/ad.png\",\"link\":\"https://example.test/\"}}");
                Ads.Ad ad = baziness.ads().get();
                equal(ad.id, 4294967297L);
                equal(ad.title, "Sponsor");
                equal(ad.imageUrl, "https://example.test/ad.png");
                equal(ad.link, "https://example.test/");
                check(sdk(13, "fake-client-secret-13").ads().get() == null, "ad scoped to client");
                control("expire-client-tokens", "{}");
                equal(baziness.ads().get().id, ad.id);
                long userId = baziness.players().signIn(new SignInRequest("ad-user", "Android", "Direct")).userId;
                baziness.ads().seen(ad.id, userId);
                baziness.ads().click(ad.id, userId);
                List<?> events = (List<?>) Json.object(control("state", null)).get("adEvents");
                equal(events.size(), 2);
                equal(Json.number(Json.object(events.get(0)), "adId"), ad.id);
                equal(Json.number(Json.object(events.get(0)), "userId"), userId);
                equal(Json.string(Json.object(events.get(0)), "eventType"), "seen");
                equal(Json.string(Json.object(events.get(1)), "eventType"), "click");
                control("fail", "{\"path\":\"/api/content/ad-event\",\"status\":500,\"times\":1}");
                try { baziness.ads().seen(ad.id, userId); check(false, "500 must fail"); }
                catch (BazinessException e) { equal(e.status(), 500); }
                equal(requests("/api/content/ad-event"), 3);
                try { baziness.ads().click(ad.id, 0); check(false, "invalid user must fail"); }
                catch (IllegalArgumentException expected) { /* Before the network. */ }
                equal(requests("/api/content/ad-event"), 3);
                control("ad", "{\"ad\":{}}");
                try { baziness.ads().get(); check(false, "malformed ad must fail"); }
                catch (BazinessException e) { equal(e.operation(), "getAd"); }
            });
            test("reads a player's campaign, matching a pending install by its fingerprint", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("fp", "Android", "Direct")).userId;
                equal(baziness.players().campaign(userId).status, "pending");

                control("click", "{\"linkCode\":\"autumn\",\"clickId\":\"c1\",\"utmSource\":\"instagram\",\"ip\":\"31.2.246.186\"}");
                Campaign campaign = baziness.players().campaign(userId,
                        new DeviceFingerprint("31.2.246.186", "Mozilla/5.0 (Linux; Android 15; A142)").withDevice("A142", "15"));
                check(campaign.found && !campaign.isPending(), "attributed");
                equal(campaign.matchType, "probabilistic");
                equal(campaign.campaignCode, "autumn");
                equal(campaign.clickId, "c1");
                equal(campaign.utmSource, "instagram");
                try {
                    sdk(13, "fake-client-secret-13").players().campaign(userId);
                    check(false, "another game's player is refused");
                } catch (BazinessException e) {
                    equal(e.status(), 403);
                }
            });
            test("pays a grant once and re-authenticates after the client token expires", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("d", "Web", "Direct")).userId;
                Coins.AddResult paid = baziness.coins().add(userId, 50, "match:17", null);
                equal(paid.credited, 50L);
                try {
                    baziness.coins().add(userId, 50, "match:17", null);
                    check(false, "a later call for the same payout must be refused");
                } catch (BazinessException e) {
                    equal(e.code(), BazinessException.ADD_COIN_REFUSED);
                }
                control("expire-client-tokens", "{}");
                equal(baziness.coins().balance(userId), 50L);
            });
            test("a lost answer then a refused retry is already credited; an uncovered payout is refused", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("d", "Android", "CafeBazaar")).userId;
                control("drop-after-credit", "{\"times\":1}");
                Coins.AddResult paid = baziness.coins().add(userId, 50, "match:17", null);
                check(paid.alreadyCredited && paid.credited == null, "already credited after the lost answer");
                equal(baziness.coins().balance(userId), 50L);

                control("client-wallet", "{\"clientId\":12,\"balance\":130}");
                try {
                    baziness.coins().add(userId, 500, "tutorial", null);
                    check(false, "an uncovered payout must be refused");
                } catch (BazinessException e) {
                    equal(e.code(), BazinessException.ADD_COIN_REFUSED);
                }
                equal(baziness.coins().balance(userId), 50L);
            });
            test("retries a 503 and a dropped connection on idempotent calls", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("d", "Web", "Direct")).userId;
                control("fail", "{\"path\":\"/api/client/get-coin/" + userId + "\",\"status\":503,\"times\":1}");
                control("fail", "{\"path\":\"/api/client/get-coin/" + userId + "\",\"status\":0,\"times\":1}");
                equal(baziness.coins().balance(userId), 0L);
            });
            test("records a purchase and sends sessions with device data through the trusted channel", () -> {
                BazinessServer baziness = sdk();
                long userId = baziness.players().signIn(new SignInRequest("d", "Android", "CafeBazaar")).userId;
                DeviceInfo device = new DeviceInfo();
                device.model = "Pixel 8";
                device.screenWidth = 1080;
                device.screenHeight = 2400;
                String sessionId = baziness.analytics().sessions().ensure(userId, device);
                equal(baziness.analytics().sessions().ensure(userId, null), sessionId);
                baziness.analytics().levelComplete(userId, "7", 1200.0, null);
                baziness.purchases().record(new Purchases.Purchase(userId, 49000, "cafebazaar", "order-1").sku("gems_100"));
                baziness.purchases().record(new Purchases.Purchase(userId, 99000, "baziness_pay", "pay-token-1").provider("zarinpal"));
                baziness.analytics().sessions().end(userId);
                check(!baziness.analytics().track(userId, "Bad Name"), "invalid name dropped");
                baziness.analytics().flush();
                List<String> keys = new ArrayList<String>();
                for (Object event : (List<?>) Json.object(control("state", null)).get("serverEvents")) {
                    keys.add(Json.string(Json.object(event), "eventKey"));
                }
                equal(keys.toString(), "[auth_login, session_start, device_info, level_complete, iap_purchase_completed, iap_purchase_completed, session_end]");
            });
            test("Baziness Pay: finds, verifies the token of and consumes a paid payment once", () -> {
                Pay pay = sdk().pay("com.example.game");
                check(pay.find(7, "gems_100") == null, "nothing paid yet");
                String token = Json.string(Json.object(control("pay-payment", "{\"uid\":7,\"sku\":\"gems_100\"}")), "token");
                Pay.Payment payment = pay.find(7, "gems_100");
                equal(payment.token, token);
                equal(payment.amount, 49000L);
                check(pay.verify(7, "gems_100", token), "its own token");
                check(!pay.verify(7, "gems_100", "made-up-token"), "not another token, though Pay alone accepts it");
                check(!pay.verify(8, "gems_100", token), "not another player");
                check(pay.consume(7, "gems_100"), "consumed");
                check(!pay.consume(7, "gems_100"), "nothing left to consume");
                check(!pay.verify(7, "gems_100", token), "consumed");
            });
            test("Baziness Pay: the bank checks a payment it did not report back; a lost consume answer still counts", () -> {
                Pay pay = sdk().pay("com.example.game");
                String token = Json.string(Json.object(control("pay-payment",
                        "{\"uid\":7,\"sku\":\"gems_100\",\"status\":\"ready\"}")), "token");
                check(!pay.verify(7, "gems_100", "other"), "not another token");
                check(pay.verify(7, "gems_100", token), "the gateway's token");
                control("drop-after-consume", "{\"times\":1}");
                check(pay.consume(7, "gems_100"), "consumed though the answer was lost");
                try {
                    sdk().pay("com.unknown.game").find(7, "gems_100");
                    throw new AssertionError("expected an exception");
                } catch (BazinessException e) {
                    equal(e.code(), "no_required_params");
                }
                equal(BazinessServer.builder(Environment.PRODUCTION, 12, "x").build().payBase(), "https://pay.baziness.com");
            });
            test("keeps events while the platform is unavailable and sends them on close", () -> {
                HttpOptions http = new HttpOptions();
                http.maxAttempts = 1;
                http.breakerThreshold = 0;
                BazinessServer baziness = sdk(12, "fake-client-secret-12", http);
                long userId = baziness.players().signIn(new SignInRequest("d", "Web", "Direct")).userId;
                control("fail", "{\"path\":\"/api/analytics/server-events/batch\",\"status\":503,\"times\":1}");
                baziness.analytics().tutorialComplete(userId, null);
                baziness.analytics().flush();
                equal(baziness.analytics().pending(), 2);
                baziness.close();
                equal(baziness.analytics().pending(), 0);
            });
        } finally {
            hub.destroy();
        }
        System.out.println(passed + " passed, " + failures.size() + " failed");
        for (String failure : failures) {
            System.out.println("  FAIL " + failure);
        }
        System.exit(failures.isEmpty() ? 0 : 1);
    }

    // ── helpers ──

    private static int requests(String pathPrefix) throws Exception {
        int count = 0;
        for (Object request : (List<?>) Json.object(control("state", null)).get("requests")) {
            if (Json.string(Json.object(request), "path").startsWith(pathPrefix)) {
                count++;
            }
        }
        return count;
    }

    private static BazinessServer sdk() {
        return sdk(12, "fake-client-secret-12");
    }

    private static BazinessServer sdk(long clientId, String secret) {
        HttpOptions http = new HttpOptions();
        http.retryBaseMs = 10;
        return sdk(clientId, secret, http);
    }

    private static BazinessServer sdk(long clientId, String secret, HttpOptions http) {
        AnalyticsOptions analytics = new AnalyticsOptions();
        analytics.flushIntervalMs = 60000;
        return BazinessServer.builder(Environment.STAGING, clientId, secret)
                .apiBaseUrl(apiBase).payBaseUrl(payBase).http(http).analytics(analytics)
                .logger(BazinessLogger.SILENT).build();
    }

    private static void test(String name, Check check) {
        try {
            control("reset", "{}");
            check.run();
            passed++;
            System.out.println("  ok   " + name);
        } catch (Throwable e) {
            failures.add(name + ": " + e);
            System.out.println("  FAIL " + name + ": " + e);
        }
    }

    private static void check(boolean condition, String what) {
        if (!condition) {
            throw new AssertionError(what);
        }
    }

    private static void equal(Object actual, Object expected) {
        if (actual == null ? expected != null : !actual.equals(expected)) {
            throw new AssertionError("expected <" + expected + "> but was <" + actual + ">");
        }
    }

    private static List<?> users() throws Exception {
        return (List<?>) Json.object(control("state", null)).get("users");
    }

    private static Object accountOf(long userId) throws Exception {
        for (Object user : users()) {
            Map<String, Object> map = Json.object(user);
            if (Json.number(map, "userId") == userId) {
                return map.get("accountId");
            }
        }
        return null;
    }

    private static Object control(String path, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(controlBase + path).openConnection();
        connection.setRequestMethod(body == null ? "GET" : "POST");
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            OutputStream out = connection.getOutputStream();
            out.write(body.getBytes(StandardCharsets.UTF_8));
            out.close();
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder text = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            text.append(line);
        }
        reader.close();
        return Json.parse(text.toString());
    }

    private static Process startFakeHub() throws Exception {
        File script = new File("../tools/fake-hub/fake-hub.mjs").getCanonicalFile();
        Process process = new ProcessBuilder("node", script.getPath(), "0").redirectErrorStream(true).start();
        BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        String line = reader.readLine();
        if (line == null || !line.startsWith("fake-hub listening on ")) {
            throw new IllegalStateException("fake hub did not start: " + line);
        }
        String port = line.substring("fake-hub listening on ".length()).trim();
        controlBase = "http://127.0.0.1:" + port + "/__control/";
        apiBase = "http://127.0.0.1:" + port + "/api";
        payBase = "http://127.0.0.1:" + port + "/pay";
        Map<String, Object> ignored = new LinkedHashMap<String, Object>();
        ignored.clear();
        return process;
    }
}
