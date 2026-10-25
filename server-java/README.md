# baziness-server (Java)

Baziness for your game **server**, Java 8+, no dependencies — made for SmartFox extensions like
Yatzy's, and any other JVM server. Same API and behaviour as `@baziness/server`.

## Install

After the package is published to Maven Central:

```xml
<dependency>
  <groupId>com.baziness</groupId>
  <artifactId>baziness-server</artifactId>
  <version>1.0.0</version>
</dependency>
```

## Quick start

```java
BazinessServer baziness = BazinessServer.fromEnv(System.getenv())
        .refreshTokens(new JdbcRefreshTokenStore(dataSource))   // yours: a baziness_sessions table
        .build();

SignInResult session = baziness.players().signIn(
        new SignInRequest(deviceId, "Android", "CafeBazaar").userId(savedUserId).linkCode(linkCode));
Players.LinkCode code = baziness.players().linkCode(session.userId);
baziness.coins().add(session.userId, 50, "match:" + matchId, null);
baziness.analytics().sessions().start(session.userId, device);   // SmartFox USER_LOGIN
baziness.analytics().sessions().end(session.userId);             // USER_DISCONNECT / USER_LOGOUT
baziness.close();                                                // extension destroy()
```

Calls block: make them from a worker thread, never from SmartFox's I/O threads.

```bash
./build.sh           # javac --release 8 → out/baziness-server-1.0.0.jar, then 12 tests (needs Node for the fake platform)
```
