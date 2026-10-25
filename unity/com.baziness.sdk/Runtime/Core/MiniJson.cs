using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Baziness
{
    /// <summary>
    /// The little JSON the SDK needs (JsonUtility cannot do dictionaries): objects become
    /// <c>Dictionary&lt;string, object&gt;</c>, arrays <c>List&lt;object&gt;</c>, numbers <c>double</c>.
    /// </summary>
    public static class MiniJson
    {
        public static string Serialize(object value)
        {
            var builder = new StringBuilder();
            Write(value, builder);
            return builder.ToString();
        }

        public static object Deserialize(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var parser = new Parser(json);
            var value = parser.ParseValue();
            parser.SkipWhitespace();
            if (!parser.AtEnd) throw new FormatException("trailing characters in JSON");
            return value;
        }

        public static Dictionary<string, object> Object(object value)
        {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public static string String(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        public static long Long(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var value) && value is double number ? (long)number : 0L;
        }

        public static bool Bool(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var value) && value is bool flag && flag;
        }

        private static void Write(object value, StringBuilder builder)
        {
            switch (value)
            {
                case null:
                    builder.Append("null");
                    break;
                case string text:
                    WriteString(text, builder);
                    break;
                case bool flag:
                    builder.Append(flag ? "true" : "false");
                    break;
                case IDictionary dictionary:
                    builder.Append('{');
                    var first = true;
                    foreach (DictionaryEntry entry in dictionary)
                    {
                        if (entry.Value == null) continue;
                        if (!first) builder.Append(',');
                        first = false;
                        WriteString(Convert.ToString(entry.Key, CultureInfo.InvariantCulture), builder);
                        builder.Append(':');
                        Write(entry.Value, builder);
                    }
                    builder.Append('}');
                    break;
                case IEnumerable list:
                    builder.Append('[');
                    var firstItem = true;
                    foreach (var item in list)
                    {
                        if (!firstItem) builder.Append(',');
                        firstItem = false;
                        Write(item, builder);
                    }
                    builder.Append(']');
                    break;
                case float or double:
                    var real = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                    builder.Append(double.IsNaN(real) || double.IsInfinity(real) ? "null" : real.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case IFormattable number:
                    builder.Append(number.ToString(null, CultureInfo.InvariantCulture));
                    break;
                default:
                    WriteString(value.ToString(), builder);
                    break;
            }
        }

        private static void WriteString(string text, StringBuilder builder)
        {
            builder.Append('"');
            foreach (var c in text)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
        }

        private sealed class Parser
        {
            private readonly string json;
            private int position;

            public Parser(string json)
            {
                this.json = json;
            }

            public bool AtEnd => position >= json.Length;

            public void SkipWhitespace()
            {
                while (position < json.Length && char.IsWhiteSpace(json[position])) position++;
            }

            public object ParseValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("unexpected end of JSON");
                switch (json[position])
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return ParseString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ParseNumber();
                }
            }

            private Dictionary<string, object> ParseObject()
            {
                var result = new Dictionary<string, object>();
                position++;
                SkipWhitespace();
                if (Peek() == '}')
                {
                    position++;
                    return result;
                }
                while (true)
                {
                    SkipWhitespace();
                    var key = ParseString();
                    SkipWhitespace();
                    Consume(':');
                    result[key] = ParseValue();
                    SkipWhitespace();
                    if (Peek() == ',')
                    {
                        position++;
                        continue;
                    }
                    Consume('}');
                    return result;
                }
            }

            private List<object> ParseArray()
            {
                var result = new List<object>();
                position++;
                SkipWhitespace();
                if (Peek() == ']')
                {
                    position++;
                    return result;
                }
                while (true)
                {
                    result.Add(ParseValue());
                    SkipWhitespace();
                    if (Peek() == ',')
                    {
                        position++;
                        continue;
                    }
                    Consume(']');
                    return result;
                }
            }

            private string ParseString()
            {
                Consume('"');
                var builder = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw new FormatException("unterminated string");
                    var c = json[position++];
                    if (c == '"') return builder.ToString();
                    if (c != '\\')
                    {
                        builder.Append(c);
                        continue;
                    }
                    var escaped = json[position++];
                    switch (escaped)
                    {
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'u':
                            builder.Append((char)int.Parse(json.Substring(position, 4), NumberStyles.HexNumber));
                            position += 4;
                            break;
                        default: builder.Append(escaped); break;
                    }
                }
            }

            private object ParseNumber()
            {
                var start = position;
                while (position < json.Length && "+-0123456789.eE".IndexOf(json[position]) >= 0) position++;
                if (start == position) throw new FormatException("unexpected character in JSON");
                return double.Parse(json.Substring(start, position - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }

            private void Expect(string literal)
            {
                if (string.CompareOrdinal(json, position, literal, 0, literal.Length) != 0)
                    throw new FormatException("expected " + literal);
                position += literal.Length;
            }

            private void Consume(char c)
            {
                if (Peek() != c) throw new FormatException("expected '" + c + "'");
                position++;
            }

            private char Peek()
            {
                return position < json.Length ? json[position] : '\0';
            }
        }
    }
}
