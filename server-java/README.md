# baziness-server (Java)

Baziness for your game **server**, Java 8+, no dependencies — made for SmartFox extensions like
Yatzy's, and any other JVM server. Same API and behaviour as `@baziness/server`.

## Install

Download `baziness-sdk-java-1.1.0.jar` from the
[v1.1.0 GitHub release](https://github.com/baziness-com/baziness-sdk/releases/tag/v1.1.0) and add
it to your server's classpath. The JAR has no runtime dependencies and targets Java 8.

```bash
javac -cp baziness-sdk-java-1.1.0.jar YourGameServer.java
```

## Quick start

```java
// No player token to store: the client secret gets a new access token whenever one is needed.
BazinessServer baziness = BazinessServer.fromEnv(System.getenv()).build();

SignInResult session = baziness.players().signIn(
        new SignInRequest(deviceId, "Android", "CafeBazaar").userId(savedUserId).linkCode(linkCode));
Players.LinkCode code = baziness.players().linkCode(session.userId);
baziness.coins().add(session.userId, 50, "match:" + matchId, null);
baziness.analytics().sessions().start(session.userId, device);   // SmartFox USER_LOGIN
baziness.analytics().sessions().end(session.userId);             // USER_DISCONNECT / USER_LOGOUT
baziness.analytics().levelComplete(session.userId, "7", 1200.0, null);   // one method per event
baziness.close();                                                // extension destroy()
```

Calls block: make them from a worker thread, never from SmartFox's I/O threads.

```bash
./build.sh           # javac --release 8 → out/baziness-server-1.1.0.jar, then 12 tests (needs Node for the fake platform)
```
