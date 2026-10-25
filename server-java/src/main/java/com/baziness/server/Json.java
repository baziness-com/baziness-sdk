package com.baziness.server;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The little JSON the platform API needs, so the SDK has no dependencies: objects become
 * {@code Map<String, Object>}, arrays {@code List<Object>}, numbers {@code Long} or {@code Double}.
 */
final class Json {
    private Json() {
    }

    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            writeString((String) value, out);
        } else if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                out.append("null");
            } else if (value instanceof Double || value instanceof Float) {
                out.append(number == Math.rint(number) && Math.abs(number) < 1e15 ? Long.toString((long) number) : value.toString());
            } else {
                out.append(value.toString());
            }
        } else if (value instanceof Boolean) {
            out.append(value.toString());
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) {
                if (entry.getValue() == null) {
                    continue;
                }
                if (!first) {
                    out.append(',');
                }
                first = false;
                writeString(entry.getKey(), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof Iterable) {
            out.append('[');
            Iterator<?> iterator = ((Iterable<?>) value).iterator();
            while (iterator.hasNext()) {
                write(iterator.next(), out);
                if (iterator.hasNext()) {
                    out.append(',');
                }
            }
            out.append(']');
        } else {
            writeString(value.toString(), out);
        }
    }

    private static void writeString(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    static Object parse(String text) {
        Parser parser = new Parser(text);
        parser.skipWhitespace();
        Object value = parser.value();
        parser.skipWhitespace();
        if (parser.position != text.length()) {
            throw new IllegalArgumentException("trailing characters at " + parser.position);
        }
        return value;
    }

    private static final class Parser {
        private final String text;
        private int position;

        Parser(String text) {
            this.text = text;
        }

        Object value() {
            if (position >= text.length()) {
                throw new IllegalArgumentException("unexpected end of JSON");
            }
            char c = text.charAt(position);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return number();
            }
        }

        private Map<String, Object> object() {
            Map<String, Object> result = new LinkedHashMap<String, Object>();
            position++;
            skipWhitespace();
            if (peek() == '}') {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                String key = string();
                skipWhitespace();
                consume(':');
                skipWhitespace();
                result.put(key, value());
                skipWhitespace();
                if (peek() == ',') {
                    position++;
                    continue;
                }
                consume('}');
                return result;
            }
        }

        private List<Object> array() {
            List<Object> result = new ArrayList<Object>();
            position++;
            skipWhitespace();
            if (peek() == ']') {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                result.add(value());
                skipWhitespace();
                if (peek() == ',') {
                    position++;
                    continue;
                }
                consume(']');
                return result;
            }
        }

        private String string() {
            consume('"');
            StringBuilder out = new StringBuilder();
            while (true) {
                if (position >= text.length()) {
                    throw new IllegalArgumentException("unterminated string");
                }
                char c = text.charAt(position++);
                if (c == '"') {
                    return out.toString();
                }
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char escaped = text.charAt(position++);
                switch (escaped) {
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'u':
                        out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                        position += 4;
                        break;
                    default: out.append(escaped);
                }
            }
        }

        private Object number() {
            int start = position;
            while (position < text.length() && "+-0123456789.eE".indexOf(text.charAt(position)) >= 0) {
                position++;
            }
            String literal = text.substring(start, position);
            if (literal.isEmpty()) {
                throw new IllegalArgumentException("unexpected character at " + start);
            }
            if (literal.indexOf('.') < 0 && literal.indexOf('e') < 0 && literal.indexOf('E') < 0) {
                return Long.parseLong(literal);
            }
            return Double.parseDouble(literal);
        }

        private void expect(String literal) {
            if (!text.startsWith(literal, position)) {
                throw new IllegalArgumentException("expected " + literal + " at " + position);
            }
            position += literal.length();
        }

        private void consume(char c) {
            if (peek() != c) {
                throw new IllegalArgumentException("expected '" + c + "' at " + position);
            }
            position++;
        }

        private char peek() {
            return position < text.length() ? text.charAt(position) : '\0';
        }

        void skipWhitespace() {
            while (position < text.length() && Character.isWhitespace(text.charAt(position))) {
                position++;
            }
        }
    }

    // ── typed reads of parsed objects ──

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : new LinkedHashMap<String, Object>();
    }

    static String string(Map<String, Object> object, String key) {
        Object value = object.get(key);
        return value == null ? null : value.toString();
    }

    static long number(Map<String, Object> object, String key) {
        Object value = object.get(key);
        return value instanceof Number ? ((Number) value).longValue() : 0L;
    }

    static boolean bool(Map<String, Object> object, String key) {
        return Boolean.TRUE.equals(object.get(key));
    }
}
