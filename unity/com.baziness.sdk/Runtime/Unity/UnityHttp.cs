using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine.Networking;

namespace Baziness
{
    /// <summary><see cref="IHttp"/> over <c>UnityWebRequest</c>; completes on the main thread.</summary>
    public sealed class UnityHttp : IHttp
    {
        private readonly int timeoutSeconds;

        public UnityHttp(int timeoutSeconds = 15)
        {
            this.timeoutSeconds = timeoutSeconds;
        }

        public Task<HttpResult> Send(string method, string url, string jsonBody, IDictionary<string, string> headers)
        {
            var request = new UnityWebRequest(url, method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = timeoutSeconds
            };
            if (jsonBody != null) request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(jsonBody));
            if (headers != null)
                foreach (var header in headers) request.SetRequestHeader(header.Key, header.Value);

            var completion = new TaskCompletionSource<HttpResult>();
            request.SendWebRequest().completed += _ =>
            {
                var reached = request.result != UnityWebRequest.Result.ConnectionError;
                completion.SetResult(new HttpResult
                {
                    Status = reached ? (int)request.responseCode : 0,
                    Body = request.downloadHandler?.text
                });
                request.Dispose();
            };
            return completion.Task;
        }
    }

    /// <summary>The analytics queue in a file under <c>Application.persistentDataPath</c>.</summary>
    public sealed class FileQueueStorage : IQueueStorage
    {
        private readonly string path;

        public FileQueueStorage(string fileName = "baziness-events.json")
        {
            path = System.IO.Path.Combine(UnityEngine.Application.persistentDataPath, fileName);
        }

        public string Load()
        {
            try
            {
                return System.IO.File.Exists(path) ? System.IO.File.ReadAllText(path) : null;
            }
            catch (System.IO.IOException)
            {
                return null;
            }
        }

        public void Save(string json)
        {
            try
            {
                if (json == null)
                {
                    if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
                }
                else
                {
                    System.IO.File.WriteAllText(path, json);
                }
            }
            catch (System.IO.IOException)
            {
                // A full disk must not break the game; the events stay in memory.
            }
        }
    }
}
