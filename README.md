# Ppopgi (뽑기) Cache Worker

Ppopgi Cache Worker is a lightweight background service designed to improve frontend performance and data freshness by caching frequently accessed protocol data derived from the subgraph and on-chain sources.

The worker periodically aggregates and normalizes lottery metadata such as status, prize pools, ticket counts, deadlines, participants and recent activity. This processed data is stored in a fast cache layer that the frontend can query with minimal latency.

Its responsibilities include:
- Polling the subgraph for newly created lotteries and state updates
- Computing derived metrics (win odds, progress to minimum, remaining tickets, etc.)
- Caching activity feed items for real-time UI display
- Preloading lottery details to reduce modal load times
- Serving a stable, low-latency data layer for dashboards and lists

The cache worker is purely an optimization layer:
- It does not modify on-chain state
- It is not required for protocol correctness
- The frontend can fall back to direct subgraph queries if unavailable

By offloading heavy read aggregation and repeated calculations, the cache worker enables smoother UI interactions, faster page loads and a more responsive real-time experience while preserving the protocol’s trustless architecture.