// Regression test for iii-hq/iii#1619 — engine-originated spans must
// export a non-empty service.name resource through the engine SdkTracerProvider.
//
// This test intentionally lives in its own integration-test binary: init_otel
// stores TRACER_PROVIDER in a process-global OnceLock and installs a global
// OpenTelemetry provider, so sharing a process with other OTEL tests would make
// the assertions order-dependent.

use std::sync::Arc;
use std::time::Duration;

use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
    trace_service_server::{TraceService, TraceServiceServer},
};
use tokio::sync::Mutex;
use tonic::transport::Server;
use tonic::{Request, Response, Status};
use tracing_subscriber::prelude::*;

#[derive(Default, Clone)]
struct CapturingTraceService {
    received: Arc<Mutex<Vec<ExportTraceServiceRequest>>>,
}

#[tonic::async_trait]
impl TraceService for CapturingTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        self.received.lock().await.push(request.into_inner());
        Ok(Response::new(ExportTraceServiceResponse::default()))
    }
}

struct EnvVarGuard {
    name: &'static str,
    value: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let guard = Self {
            name,
            value: std::env::var_os(name),
        };
        unsafe {
            std::env::set_var(name, value);
        }
        guard
    }

    fn remove(name: &'static str) -> Self {
        let guard = Self {
            name,
            value: std::env::var_os(name),
        };
        unsafe {
            std::env::remove_var(name);
        }
        guard
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.value {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }
}

async fn spawn_mock_collector() -> (String, Arc<Mutex<Vec<ExportTraceServiceRequest>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}");

    let service = CapturingTraceService::default();
    let received = service.received.clone();

    tokio::spawn(async move {
        let incoming = tokio_stream::wrappers::TcpListenerStream::new(listener);
        Server::builder()
            .add_service(TraceServiceServer::new(service))
            .serve_with_incoming(incoming)
            .await
            .expect("mock OTLP collector failed to start; see tonic transport error above")
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match tokio::net::TcpStream::connect(addr).await {
            Ok(_) => break,
            Err(_) if std::time::Instant::now() < deadline => {
                tokio::task::yield_now().await;
            }
            Err(e) => panic!("mock collector not reachable within 2s: {e}"),
        }
    }

    (endpoint, received)
}

fn find_string_attr<'a>(
    attrs: &'a [opentelemetry_proto::tonic::common::v1::KeyValue],
    key: &str,
) -> Option<&'a str> {
    attrs
        .iter()
        .find(|kv| kv.key == key)
        .and_then(|kv| kv.value.as_ref())
        .and_then(|v| v.value.as_ref())
        .and_then(|v| match v {
            opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(s) => {
                Some(s.as_str())
            }
            _ => None,
        })
}

fn resource_for_span<'a>(
    req: &'a ExportTraceServiceRequest,
    span_name: &str,
) -> Option<&'a opentelemetry_proto::tonic::resource::v1::Resource> {
    req.resource_spans.iter().find_map(|resource_spans| {
        let has_span = resource_spans
            .scope_spans
            .iter()
            .any(|scope_spans| scope_spans.spans.iter().any(|span| span.name == span_name));

        has_span.then(|| resource_spans.resource.as_ref()).flatten()
    })
}

#[tokio::test]
async fn engine_originated_spans_fall_back_to_otel_service_name_when_config_service_name_is_blank()
{
    let _service_name = EnvVarGuard::set("OTEL_SERVICE_NAME", "iii-engine");
    let _resource_attrs = EnvVarGuard::remove("OTEL_RESOURCE_ATTRIBUTES");

    let (endpoint, received) = spawn_mock_collector().await;
    let config = iii::workers::observability::otel::OtelConfig {
        enabled: true,
        service_name: String::new(),
        service_version: "test-version".to_string(),
        service_namespace: None,
        exporter: iii::workers::observability::otel::ExporterType::Otlp,
        endpoint,
        sampling_ratio: 1.0,
        memory_max_spans: 10,
    };

    let otel_layer = iii::workers::observability::otel::init_otel(&config)
        .expect("OpenTelemetry should initialize for the mock collector");
    let subscriber = tracing_subscriber::registry().with(otel_layer);

    tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!("engine-originated-test-span");
        let _enter = span.enter();
        tracing::info!("emitting engine-originated span for iii#1619 regression test");
    });

    iii::workers::observability::otel::shutdown_otel();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if !received.lock().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let captured = received.lock().await;
    assert_eq!(
        captured.len(),
        1,
        "Mock collector should have received exactly one engine-originated ExportTraceServiceRequest"
    );

    let resource = resource_for_span(&captured[0], "engine-originated-test-span")
        .expect("engine-originated test span should be exported with a Resource block");

    assert_eq!(
        find_string_attr(&resource.attributes, "service.name"),
        Some("iii-engine"),
        "engine-originated spans must use OTEL_SERVICE_NAME when config service_name is blank"
    );
    assert_eq!(
        find_string_attr(&resource.attributes, "service.version"),
        Some("test-version"),
        "engine-originated spans should preserve the configured service.version resource attribute"
    );
}
