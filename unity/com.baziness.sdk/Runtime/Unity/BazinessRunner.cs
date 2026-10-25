using UnityEngine;

namespace Baziness
{
    /// <summary>Hidden helper the SDK creates: sends analytics on a timer and when the app goes to the background.</summary>
    [AddComponentMenu("")]
    internal sealed class BazinessRunner : MonoBehaviour
    {
        private float nextTick;

        private void Update()
        {
            if (Time.unscaledTime < nextTick) return;
            nextTick = Time.unscaledTime + 1f;
            BazinessSdk.Analytics?.Tick();
        }

        private void OnApplicationPause(bool paused)
        {
            if (paused) _ = BazinessSdk.Analytics?.Flush(true);
        }

        private void OnApplicationFocus(bool focused)
        {
            if (!focused) _ = BazinessSdk.Analytics?.Flush(true);
        }

        private void OnApplicationQuit()
        {
            _ = BazinessSdk.Analytics?.Flush(true);
        }
    }
}
