namespace Baziness.Server;

/// <summary>Where the SDK writes what it does. It never logs secrets or tokens.</summary>
public interface IBazinessLogger
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
}

public static class BazinessLogger
{
    /// <summary>Says nothing; the default.</summary>
    public static readonly IBazinessLogger Silent = From(_ => { }, _ => { }, _ => { });

    /// <summary>Writes to standard output and standard error.</summary>
    public static readonly IBazinessLogger Console = From(
        System.Console.WriteLine, System.Console.WriteLine, System.Console.Error.WriteLine);

    /// <summary>Routes to whatever your server logs with, e.g. <c>m => log.LogWarning("{Message}", m)</c>.</summary>
    public static IBazinessLogger From(Action<string> info, Action<string> warn, Action<string> error) =>
        new DelegateLogger(info, warn, error);

    private sealed class DelegateLogger(Action<string> info, Action<string> warn, Action<string> error) : IBazinessLogger
    {
        public void Info(string message) => info(message);
        public void Warn(string message) => warn(message);
        public void Error(string message) => error(message);
    }
}
