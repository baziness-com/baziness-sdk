using System.Collections.Generic;
using System.Threading.Tasks;

namespace Baziness
{
    public sealed class HttpResult
    {
        /// <summary>0 when the request did not reach a server (offline, DNS, timeout).</summary>
        public int Status;
        public string Body;

        public bool Ok => Status >= 200 && Status < 300;
    }

    /// <summary>
    /// How the SDK sends HTTP requests: <c>UnityWebRequest</c> in the game, <c>HttpClient</c> in tests.
    /// An implementation never throws for HTTP errors or network failures: it returns the status (0 = no answer).
    /// </summary>
    public interface IHttp
    {
        Task<HttpResult> Send(string method, string url, string jsonBody, IDictionary<string, string> headers);
    }

    /// <summary>Where queued analytics events are kept between launches.</summary>
    public interface IQueueStorage
    {
        string Load();
        void Save(string json);
    }

    public sealed class MemoryQueueStorage : IQueueStorage
    {
        private string value;

        public string Load()
        {
            return value;
        }

        public void Save(string json)
        {
            value = json;
        }
    }
}
