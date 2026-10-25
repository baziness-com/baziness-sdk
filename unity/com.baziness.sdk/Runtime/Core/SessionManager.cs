using System;
using System.Threading.Tasks;

namespace Baziness
{
    /// <summary>
    /// The player's Baziness session on the device: a 15-minute access token from your server, renewed
    /// through your server when it is about to expire or a call answers 401. Never stored on the device:
    /// your server keeps the refresh token.
    /// </summary>
    public sealed class SessionManager
    {
        private static readonly TimeSpan RenewBefore = TimeSpan.FromMinutes(1);

        private readonly IGameBackend backend;
        private readonly Func<DateTime> clock;
        private Task<BackendSession> pending;
        private string linkCode;
        private Attribution attribution;

        public DeviceInfo Device;
        public BackendSession Current { get; private set; }
        public event Action<BackendSession> Changed;

        public SessionManager(IGameBackend backend, DeviceInfo device, Func<DateTime> utcClock = null)
        {
            this.backend = backend;
            Device = device;
            clock = utcClock ?? (() => DateTime.UtcNow);
        }

        /// <summary>A link code from a launch deep link: sent with the next session request, once.</summary>
        public void UseLaunch(LaunchParams launch, Attribution firstTouch)
        {
            if (!string.IsNullOrEmpty(launch?.LinkCode)) linkCode = launch.LinkCode;
            attribution = firstTouch;
        }

        /// <summary>A session with at least a minute left; <paramref name="force"/> asks your server anyway.</summary>
        public Task<BackendSession> Get(bool force = false)
        {
            if (!force && Current != null && Current.AccessTokenExpiresAtUtc - clock() > RenewBefore)
                return Task.FromResult(Current);
            // One request at a time; a finished one (success or failure) is never handed out again.
            if (pending == null || pending.IsCompleted) pending = Fetch();
            return pending;
        }

        public async Task<string> Token(bool force = false)
        {
            return (await Get(force)).AccessToken;
        }

        /// <summary>Forget the session (the page sent <c>logout</c>); the next <see cref="Get"/> starts over.</summary>
        public void Clear()
        {
            Current = null;
            Changed?.Invoke(null);
        }

        private async Task<BackendSession> Fetch()
        {
            var request = new SessionRequest { Device = Device, Attribution = attribution, LinkCode = linkCode };
            // A code works once: even when this request fails, the next one must not send it again.
            linkCode = null;
            var session = await backend.Session(request);
            if (session == null || string.IsNullOrEmpty(session.AccessToken))
                throw new BackendException("your server answered /session without an accessToken", 200);
            Current = session;
            Changed?.Invoke(session);
            return session;
        }
    }
}
