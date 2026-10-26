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
            test("creates a player, then gets a new access token; the server keeps no token", () -> {
                Attribution attribution = new Attribution();
                attribution.utmSource = "instagram";
                attribution.campaignCode = "spring";
                SignInResult first = sdk(null).players().signIn(
                        new SignInRequest("phone-1", "Android", "CafeBazaar").attribution(attribution));
                equal(first.method, SignInResult.Method.CREATED);
                check(first.accessToken != null && first.accessTokenExpiresAt != null, "an access token");
                equal(Json.number(Json.object(control("state", null)), "liveSessions"), 0L);
                Map<String, Object> user = Json.object(users().get(0));
                equal(Json.write(user.get("attribution")), "{\"utmSource\":\"instagram\",\"linkCode\":\"spring\"}");

                // A fresh SDK (another server, or after a restart) has no cached token: it asks again.
                SignInResult second = sdk(null).players().signIn(
                        new SignInRequest("phone-1", "Android", "CafeBazaar").userId(first.userId));
                equal(second.method, SignInResult.Method.REFRESH);
                equal(second.userId, first.userId);
                check(!second.accessToken.equals(first.accessToken), "a new access token");
                equal(requests("/api/v2/client/access-token/"), 1);
                equal(requests("/api/auth/refresh") + requests("/api/v2/client/get-user-token/"), 0);
            });
            test("joins a player arriving with a link code to the same person", () -> {
                BazinessServer yatzy = sdk(new MemoryRefreshTokenStore(), 13, "fake-client-secret-13");
                SignInResult yatzyPlayer = yatzy.players().signIn(new SignInRequest("phone", "Android", "CafeBazaar"));
                String code = Json.string(Json.object(control("link-code", "{\"userId\":" + yatzyPlayer.userId + "}")), "code");
                SignInResult falPlayer = sdk(new MemoryRefreshTokenStore()).players().signIn(
                        new SignInRequest("browser", "Web", "Direct").linkCode(code));
                equal(falPlayer.method, SignInResult.Method.LINK_CODE);
                equal(accountOf(falPlayer.userId), accountOf(yatzyPlayer.userId));
                check(accountOf(falPlayer.userId) != null, "joined into one account");
            });
            test("continues without a used link code", () -> {
                SignInResult result = sdk(new MemoryRefreshTokenStore()).players().signIn(
                        new SignInRequest("d", "Web", "Direct").linkCode("lc.used"));
                equal(result.method, SignInResult.Method.CREATED);
                check(result.linkCodeRejected, "linkCodeRejected");
            });
            test("logout ends the session a 1.0 store kept; suspended account is reported", () -> {
                MemoryRefreshTokenStore store = new MemoryRefreshTokenStore();
                BazinessServer baziness = sdk(store);
                SignInResult player = baziness.players().signIn(new SignInRequest("d", "Web", "Direct"));
                // What 1.0 did: a token pair, with the refresh token kept by the game.
                store.set(player.userId, baziness.players().newSession(player.userId).refreshToken);
                equal(Json.number(Json.object(control("state", null)), "liveSessions"), 1L);
                baziness.players().logout(player.userId);
                check(store.get(player.userId) == null, "refresh token removed");
                equal(Json.number(Json.object(control("state", null)), "liveSessions"), 0L);
                control("suspend", "{\"userId\":" + player.userId + "}");
                try {
                    sdk(null).players().session(player.userId);
                    check(false, "suspended account must throw");
                } catch (BazinessException e) {
                    equal(e.code(), "account_suspended");
                }
            });
            test("verifies a page token, gives link codes and logs out", () -> {
                BazinessServer baziness = sdk(null);
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
            test("pays a grant once and re-authenticates after the client token expires", () -> {
                BazinessServer baziness = sdk(new MemoryRefreshTokenStore());
                long userId = baziness.players().signIn(new SignInRequest("d", "Web", "Direct")).userId;
                Coins.AddResult paid = baziness.coins().add(userId, 50, "match:17", null);
                equal(paid.credited, 50L);
                check(baziness.coins().add(userId, 50, "match:17", null).alreadyCredited, "second payout refused as already paid");
                control("expire-client-tokens", "{}");
                equal(baziness.coins().balance(userId), 50L);
            });
            test("retries a 503 and a dropped connection on idempotent calls", () -> {
                BazinessServer baziness = sdk(new MemoryRefreshTokenStore());
                long userId = baziness.players().signIn(new SignInRequest("d", "Web", "Direct")).userId;
                control("fail", "{\"path\":\"/api/client/get-coin/" + userId + "\",\"status\":503,\"times\":1}");
                control("fail", "{\"path\":\"/api/client/get-coin/" + userId + "\",\"status\":0,\"times\":1}");
                equal(baziness.coins().balance(userId), 0L);
            });
            test("records a purchase and sends sessions with device data through the trusted channel", () -> {
                BazinessServer baziness = sdk(new MemoryRefreshTokenStore());
                long userId = baziness.players().signIn(new SignInRequest("d", "Android", "CafeBazaar")).userId;
                DeviceInfo device = new DeviceInfo();
                device.model = "Pixel 8";
                device.screenWidth = 1080;
                device.screenHeight = 2400;
                String sessionId = baziness.analytics().sessions().ensure(userId, device);
                equal(baziness.analytics().sessions().ensure(userId, null), sessionId);
                baziness.analytics().levelComplete(userId, "7", 1200.0, null);
                baziness.purchases().record(new Purchases.Purchase(userId, 49000, "cafebazaar", "order-1").sku("gems_100"));
                baziness.analytics().sessions().end(userId);
                check(!baziness.analytics().track(userId, "Bad Name"), "invalid name dropped");
                baziness.analytics().flush();
                List<String> keys = new ArrayList<String>();
                for (Object event : (List<?>) Json.object(control("state", null)).get("serverEvents")) {
                    keys.add(Json.string(Json.object(event), "eventKey"));
                }
                equal(keys.toString(), "[auth_login, session_start, device_info, level_complete, iap_purchase_completed, session_end]");
            });
            test("keeps events while the platform is unavailable and sends them on close", () -> {
                HttpOptions http = new HttpOptions();
                http.maxAttempts = 1;
                http.breakerThreshold = 0;
                BazinessServer baziness = sdk(new MemoryRefreshTokenStore(), 12, "fake-client-secret-12", http);
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

    private static BazinessServer sdk(RefreshTokenStore store) {
        return sdk(store, 12, "fake-client-secret-12");
    }

    private static BazinessServer sdk(RefreshTokenStore store, long clientId, String secret) {
        HttpOptions http = new HttpOptions();
        http.retryBaseMs = 10;
        return sdk(store, clientId, secret, http);
    }

    private static BazinessServer sdk(RefreshTokenStore store, long clientId, String secret, HttpOptions http) {
        AnalyticsOptions analytics = new AnalyticsOptions();
        analytics.flushIntervalMs = 60000;
        return BazinessServer.builder(Environment.STAGING, clientId, secret)
                .apiBaseUrl(apiBase).refreshTokens(store).http(http).analytics(analytics)
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
        Map<String, Object> ignored = new LinkedHashMap<String, Object>();
        ignored.clear();
        return process;
    }
}
