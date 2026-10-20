from __future__ import annotations
import queue
import threading
import time
from router_config import DB, FIFO_MAX, PROVIDERS, STICKY_TTL
from router_health import HealthDB




# ---------------------------------------------------------------------------
# State: ELO, circuit breakers, sticky, FIFO, health DB
# ---------------------------------------------------------------------------
class Matrix:
    def __init__(self) -> None:
        self.lock: threading.Lock = threading.Lock()
        self.fail: dict[str, tuple[int, float]] = {}
        self.elo: dict[str, float] = {p: 1000.0 for p in PROVIDERS}
        self.circuit: dict[str, str] = {p: "closed" for p in PROVIDERS}
        self.circuit_open_until: dict[str, float] = {}
        self.fifo: queue.Queue[int] = queue.Queue(maxsize=FIFO_MAX)
        self.health = HealthDB(DB)

    def record(
        self,
        model: str,
        prov: str,
        status: int,
        lat: float,
        winner: int = 0,
        strategy: str = "",
        session: str = "",
    ) -> None:
        lat_ms = lat * 1000
        with self.lock:
            self.health.record_request(
                prov,
                model,
                status,
                lat_ms,
                strategy,
                winner,
                session,
            )
            if status == 200:
                old_circuit = self.circuit.get(prov, "closed")
                self.elo[prov] = self.elo.get(prov, 1000) + 16
                self.fail[prov] = (0, time.time())
                self.circuit[prov] = "closed"
                if old_circuit != "closed":
                    self.health.record_healing(
                        prov,
                        model,
                        "circuit_recovered",
                        prev_status=old_circuit,
                        new_status="closed",
                    )
            elif status == 429:
                self.health.record_rate_limit(prov, model, status)
                self.elo[prov] = max(100.0, self.elo.get(prov, 1000) - 8)
                c, _ = self.fail.get(prov, (0, 0))
                self.fail[prov] = (c + 1, time.time())
            else:
                c, _ = self.fail.get(prov, (0, 0))
                self.fail[prov] = (c + 1, time.time())
                self.elo[prov] = max(100.0, self.elo.get(prov, 1000) - 32)
                if c + 1 >= 3:
                    old = self.circuit.get(prov, "closed")
                    self.circuit[prov] = "open"
                    self.circuit_open_until[prov] = time.time() + 60
                    self.health.record_healing(
                        prov,
                        model,
                        "circuit_opened",
                        prev_status=old,
                        new_status="open",
                        details=f"{c + 1} consecutive failures",
                    )

    def sticky_get(self, sid: str) -> tuple[str | None, str | None]:
        return self.health.sticky_get(sid, STICKY_TTL)

    def sticky_set(self, sid: str, p: str, m: str) -> None:
        self.health.sticky_set(sid, p, m)

    def circuit_ok(self, p: str) -> bool:
        st = self.circuit.get(p, "closed")
        if st == "closed":
            return True
        if st == "open":
            if time.time() > self.circuit_open_until.get(p, 0):
                self.circuit[p] = "half"
                return True
            return False
        return True  # half-open: allow probe




state = Matrix()
