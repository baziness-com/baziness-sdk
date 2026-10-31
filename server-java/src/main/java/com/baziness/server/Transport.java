package com.baziness.server;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/**
 * The SDK's only way to the platform: timeouts, a deadline per call, bounded retries, a limit on
 * requests in flight, a breaker per operation and the client-token 401 dance.
 */
final class Transport {
    /** One platform call. */
    static final class Call {
        final String operation;
        final String method;
        final String path;
        final Object body;
        final boolean clientAuth;
        final boolean idempotent;
        boolean expectJson = true;

        Call(String operation, String method, String path, Object body, boolean clientAuth, boolean idempotent) {
            this.operation = operation;
            this.method = method;
            this.path = path;
            this.body = body;
            this.clientAuth = clientAuth;
            this.idempotent = idempotent;
        }

        Call noJson() {
            expectJson = false;
            return this;
        }
    }

    interface ClientTokenSupplier {
        String token(long deadlineAt, boolean forceNew);
    }

    private static final class Answer {
        final int status;
        final String text;
        final long retryAfterMs;

        Answer(int status, String text, long retryAfterMs) {
            this.status = status;
            this.text = text;
            this.retryAfterMs = retryAfterMs;
        }
    }

    private final String apiBase;
    private final HttpOptions options;
    private final BazinessLogger logger;
    private final Semaphore slots;
    private final Map<String, int[]> failures = new ConcurrentHashMap<String, int[]>();
    private final Map<String, Long> openedAt = new ConcurrentHashMap<String, Long>();
    private volatile ClientTokenSupplier clientToken;

    Transport(String apiBase, HttpOptions options, BazinessLogger logger) {
        this.apiBase = apiBase;
        this.options = options;
        this.logger = logger;
        this.slots = options.maxConcurrent > 0 ? new Semaphore(options.maxConcurrent) : null;
    }

    void useClientToken(ClientTokenSupplier supplier) {
        this.clientToken = supplier;
    }

    Object request(Call call) {
        return request(call, System.currentTimeMillis() + options.deadlineMs);
    }

    Object request(Call call, long deadlineAt) {
        if (breakerOpen(call.operation)) {
            throw new BazinessException(call.operation + ": platform unavailable (circuit open)", call.operation, 0, null);
        }
        try {
            Object result = requestWithAuth(call, deadlineAt);
            failures.remove(call.operation);
            openedAt.remove(call.operation);
            return result;
        } catch (BazinessException e) {
            if (e.isUnavailable()) {
                breakerFailed(call.operation);
            }
            throw e;
        }
    }

    private Object requestWithAuth(Call call, long deadlineAt) {
        if (!call.clientAuth) {
            return parse(call, withRetries(call, deadlineAt, null));
        }
        String token = clientToken.token(deadlineAt, false);
        Answer answer = withRetries(call, deadlineAt, token);
        if (answer.status == 401) {
            // The client token expired or was revoked: authenticate again and retry once.
            token = clientToken.token(deadlineAt, true);
            answer = withRetries(call, deadlineAt, token);
        }
        return parse(call, answer);
    }

    private Object parse(Call call, Answer answer) {
        if (answer.status >= 200 && answer.status < 300) {
            if (!call.expectJson || answer.text.trim().isEmpty()) {
                return null;
            }
            try {
                return Json.parse(answer.text);
            } catch (IllegalArgumentException e) {
                throw new BazinessException(call.operation + ": the platform sent invalid JSON", call.operation, answer.status, null);
            }
        }
        String code = errorCode(answer.text);
        throw new BazinessException(call.operation + ": HTTP " + answer.status + (code != null ? " (" + code + ")" : ""),
                call.operation, answer.status, code);
    }

    private Answer withRetries(Call call, long deadlineAt, String token) {
        BazinessException last = null;
        for (int attempt = 1; attempt <= options.maxAttempts; attempt++) {
            long retryAfter = -1;
            try {
                Answer answer = once(call, deadlineAt, token);
                boolean retryable = answer.status == 429 || answer.status == 502 || answer.status == 503
                        || (call.idempotent && (answer.status == 500 || answer.status == 504));
                if (!retryable || attempt == options.maxAttempts) {
                    return answer;
                }
                retryAfter = answer.retryAfterMs;
                last = new BazinessException(call.operation + ": HTTP " + answer.status, call.operation, answer.status, null);
            } catch (IOException e) {
                // The request never left this machine, so even a non-idempotent call is safe to resend.
                boolean notSent = e instanceof ConnectException || e instanceof UnknownHostException
                        || e instanceof NoRouteToHostException;
                last = new BazinessException(call.operation + ": network error (" + e.getClass().getSimpleName() + ")",
                        call.operation, 0, null);
                if (!(call.idempotent || notSent) || attempt == options.maxAttempts) {
                    throw last;
                }
            }
            long backoff = retryAfter >= 0 ? retryAfter
                    : (long) (options.retryBaseMs * Math.pow(2, attempt - 1) * (0.5 + ThreadLocalRandom.current().nextDouble()));
            if (System.currentTimeMillis() + backoff >= deadlineAt) {
                throw last;
            }
            logger.warn("[baziness] " + last.getMessage() + "; retrying in " + backoff + " ms");
            sleep(backoff);
        }
        throw last != null ? last : new BazinessException(call.operation + ": failed", call.operation, 0, null);
    }

    private Answer once(Call call, long deadlineAt, String token) throws IOException {
        long remaining = deadlineAt - System.currentTimeMillis();
        if (remaining <= 0) {
            throw new BazinessException(call.operation + ": deadline exceeded", call.operation, 0, null);
        }
        acquire(call, remaining);
        HttpURLConnection connection = null;
        try {
            int timeout = (int) Math.max(1, Math.min(options.timeoutMs, remaining));
            connection = (HttpURLConnection) new URL(apiBase + call.path).openConnection();
            connection.setRequestMethod(call.method);
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "baziness-server-java/" + BazinessServer.SDK_VERSION);
            if (token != null) {
                connection.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (call.body != null) {
                byte[] payload = Json.write(call.body).getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                // Buffered, not streaming: in streaming mode HttpURLConnection drops the body of a
                // 401, and with it the error code (refresh_token_rotated, session_revoked, …).
                OutputStream out = connection.getOutputStream();
                try {
                    out.write(payload);
                } finally {
                    out.close();
                }
            } else if ("POST".equals(call.method)) {
                connection.setDoOutput(true);
                connection.getOutputStream().close();
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : read(stream);
            return new Answer(status, text, retryAfter(connection.getHeaderField("Retry-After")));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
            if (slots != null) {
                slots.release();
            }
        }
    }

    private void acquire(Call call, long remainingMs) {
        if (slots == null) {
            return;
        }
        try {
            if (!slots.tryAcquire(remainingMs, TimeUnit.MILLISECONDS)) {
                throw new BazinessException(call.operation + ": too many requests in flight", call.operation, 0, null);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BazinessException(call.operation + ": interrupted", call.operation, 0, null);
        }
    }

    private boolean breakerOpen(String operation) {
        if (options.breakerThreshold <= 0) {
            return false;
        }
        Long opened = openedAt.get(operation);
        if (opened == null) {
            return false;
        }
        if (System.currentTimeMillis() - opened < options.breakerResetMs) {
            return true;
        }
        // Half-open: this call is the probe; one more failure re-opens the breaker.
        openedAt.remove(operation);
        failures.put(operation, new int[]{options.breakerThreshold - 1});
        return false;
    }

    private void breakerFailed(String operation) {
        if (options.breakerThreshold <= 0) {
            return;
        }
        int[] count = failures.get(operation);
        if (count == null) {
            count = new int[1];
            failures.put(operation, count);
        }
        synchronized (count) {
            count[0]++;
            if (count[0] >= options.breakerThreshold && !openedAt.containsKey(operation)) {
                openedAt.put(operation, System.currentTimeMillis());
                count[0] = 0;
                logger.warn("[baziness] " + operation + ": circuit opened after repeated failures");
            }
        }
    }

    private static String errorCode(String text) {
        if (text == null || text.trim().isEmpty()) {
            return null;
        }
        try {
            Map<String, Object> body = Json.object(Json.parse(text));
            for (String key : new String[]{"error", "message", "title"}) {
                String value = Json.string(body, key);
                if (value != null && !value.trim().isEmpty()) {
                    return value.trim();
                }
            }
            return null;
        } catch (IllegalArgumentException e) {
            return text.length() <= 200 ? text.trim() : null;
        }
    }

    private static long retryAfter(String header) {
        if (header == null) {
            return -1;
        }
        try {
            return Math.min(Long.parseLong(header.trim()) * 1000, 30000);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String read(InputStream stream) throws IOException {
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            stream.close();
        }
    }

    /** One path segment, percent-encoded ({@code +} and spaces included). */
    static String encodePath(String segment) {
        try {
            return URLEncoder.encode(segment, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
