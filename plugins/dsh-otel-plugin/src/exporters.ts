import { Metadata } from '@grpc/grpc-js'
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace'
import type { ResolvedEndpoint } from './config.ts'

export type ExporterFactory = (endpoint: ResolvedEndpoint) => SpanExporter

/** Per-destination delivery accounting, read by the adapter to spot a queue drop. */
export type DeliveryCounters = { exported: number; failures: number }

export function createOtlpExporter(endpoint: ResolvedEndpoint): SpanExporter {
  const exporterConfig = { url: endpoint.url, timeoutMillis: endpoint.timeoutMs }
  if (endpoint.protocol === 'grpc') {
    const metadata = new Metadata()
    for (const [key, value] of Object.entries(endpoint.headers ?? {})) {
      metadata.set(key.toLowerCase(), value)
    }
    return new GrpcTraceExporter({ ...exporterConfig, metadata })
  }
  return new HttpTraceExporter({ ...exporterConfig, headers: endpoint.headers })
}

/**
 * Wrap an exporter with delivery accounting.
 *
 * `BatchSpanProcessor` drops queued spans silently, so the adapter compares created chat
 * spans against delivered spans and resyncs when the two diverge. A failed export calls
 * `onFailure` so the next span of every session republishes the full ref list.
 */
export function createCountingExporter(
  endpoint: ResolvedEndpoint,
  counters: DeliveryCounters,
  onFailure?: () => void,
  exporterFactory: ExporterFactory = createOtlpExporter,
): SpanExporter {
  const base = exporterFactory(endpoint)
  return {
    export(spans, callback) {
      base.export(spans, result => {
        if (result.code === 0) counters.exported += spans.length
        else {
          counters.failures += 1
          try {
            onFailure?.()
          } catch {
            // Diagnostics never travel back into an export path.
          }
        }
        callback(result)
      })
    },
    shutdown() {
      return base.shutdown()
    },
  }
}

export function createSpanProcessors(
  endpoints: ResolvedEndpoint[],
  exporterFactory: ExporterFactory = createOtlpExporter,
  hooks?: { counters?: DeliveryCounters; onFailure?: () => void },
): BatchSpanProcessor[] {
  const counters = hooks?.counters
  return endpoints.map(endpoint => new BatchSpanProcessor({
    exporter: counters
      ? createCountingExporter(endpoint, counters, hooks?.onFailure, exporterFactory)
      : exporterFactory(endpoint),
    maxExportBatchSize: 128,
    maxQueueSize: 4_096,
    scheduledDelayMillis: 1_000,
    exportTimeoutMillis: endpoint.timeoutMs,
  }))
}
