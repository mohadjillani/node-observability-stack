# Decision records

One per decision that would come up in a design review, each with the
trigger that would make it worth revisiting.

| ADR                                                                     | Decision                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [0001](0001-collector-as-the-single-ingestion-point.md)                 | The Collector is the single ingestion point for application telemetry      |
| [0002](0002-manual-context-propagation-through-job-data.md)             | Trace context crosses the queue in the job data, by hand, with span links  |
| [0003](0003-tail-sampling-in-the-collector.md)                          | Tail sampling in the Collector rather than head sampling in the SDK        |
| [0004](0004-alloy-over-promtail.md)                                     | Container logs through Alloy, straight to Loki, with trace ids as metadata |
| [0005](0005-exemplars-as-the-metrics-to-traces-link.md)                 | Exemplars link metrics to traces, which is why metrics use prom-client     |
| [0006](0006-esm-instrumentation-through-the-synchronous-loader-hook.md) | ESM auto-instrumentation through Node's synchronous loader hook            |

Format: Status and Date, then Context, Decision, Consequences.
