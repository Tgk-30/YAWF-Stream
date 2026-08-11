// Direct P2P uses hash-only DHT discovery. A constructor is exported because
// torrent-discovery imports this package even when tracker use is disabled.
export class Client {
  constructor() {
    throw new Error("Torrent trackers are disabled.");
  }
}
