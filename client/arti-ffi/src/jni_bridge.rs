//! The JNI surface — the symbols `StiqArtiModule.kt`'s `external fun`s bind to.
//!
//! =====================================================================================
//! WHY JNI NAMES AND NOT A PLAIN C ABI
//! =====================================================================================
//! Kotlin's `external fun` resolves by symbol name: a method `artiStart` on
//! `com.stiq.client.StiqArtiModule` looks for `Java_com_stiq_client_StiqArtiModule_artiStart`. A
//! plain `arti_start` would need a hand-written C shim in between. Exporting the JNI names directly
//! removes that layer, so this file *is* the shim.
//!
//! ⚠ **These names are load-bearing and invisible to the compiler.** Nothing here breaks if the
//! Kotlin class is renamed, the package moves, or a method is spelled differently — the build stays
//! green and `System.loadLibrary` still succeeds. It fails at runtime, on the first call, with
//! `UnsatisfiedLinkError`. If you move `StiqArtiModule`, every symbol below has to move with it.
//!
//! =====================================================================================
//! EVENTS FLOW BACK THE OTHER WAY
//! =====================================================================================
//! Arti's progress arrives on tokio worker threads that the JVM has never seen. Calling into Java
//! from one requires attaching it to the VM first, which is why we hold a `JavaVM` (process-wide,
//! safe to keep) and a `GlobalRef` to the module instance (a plain local `JObject` would be invalid
//! the moment the originating JNI call returned).
//!
//! Nothing in here may panic. The release profile sets `panic = "abort"`, so a panic on a tokio
//! worker takes the whole app down rather than surfacing as a rejected promise. Every fallible step
//! below therefore degrades to "drop this event" instead of unwrapping.

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::sys::{jboolean, jint};
use jni::{JNIEnv, JavaVM};

use crate::ffi::ArtiBootstrap;

/// Signature of `StiqArtiModule.dispatchEvent(String, int, String, int, String)`.
const DISPATCH_SIG: &str = "(Ljava/lang/String;ILjava/lang/String;ILjava/lang/String;)V";
const DISPATCH_NAME: &str = "dispatchEvent";

/// Routes `ArtiBootstrap::on_event` into `StiqArtiModule.dispatchEvent`.
struct JavaSink {
    vm: JavaVM,
    module: GlobalRef,
}

impl ArtiBootstrap for JavaSink {
    fn on_event(
        &self,
        kind: String,
        percent: i32,
        summary: String,
        socks_port: i32,
        message: String,
    ) {
        // Attaching is cheap when the thread is already attached (the guard nests), so there is no
        // need to cache attachment per worker.
        let Ok(mut guard) = self.vm.attach_current_thread() else {
            return;
        };
        let env: &mut JNIEnv = &mut guard;

        let (Ok(j_kind), Ok(j_summary), Ok(j_message)) = (
            env.new_string(&kind),
            env.new_string(&summary),
            env.new_string(&message),
        ) else {
            // Allocation failed, which in practice means the VM is going down. Say nothing.
            return;
        };

        let result = env.call_method(
            &self.module,
            DISPATCH_NAME,
            DISPATCH_SIG,
            &[
                JValue::Object(&j_kind),
                JValue::Int(percent),
                JValue::Object(&j_summary),
                JValue::Int(socks_port),
                JValue::Object(&j_message),
            ],
        );

        if result.is_err() {
            // A pending Java exception poisons every subsequent JNI call on this thread, so it has
            // to be cleared even though we are choosing not to act on it. `describe_exception`
            // prints it to logcat first, which is the only way anyone will ever see it.
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }
}

/// Register the module instance that receives events, and initialise logcat output.
///
/// Kotlin calls this once from `init`, before any `artiStart`. Registering here rather than inside
/// `artiStart` means errors raised *by* a failed start still have somewhere to go.
#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiRegisterCallback(
    env: JNIEnv,
    this: JObject,
) {
    crate::arti_init_logging();
    let (Ok(vm), Ok(module)) = (env.get_java_vm(), env.new_global_ref(this)) else {
        log::error!("artiRegisterCallback: could not take a global ref; events will be dropped");
        return;
    };
    crate::arti_set_callback(Box::new(JavaSink { vm, module }));
}

/// Start the daemon. Returns the bound SOCKS port (>0) or a negative `codes::*` value.
///
/// Blocking — Kotlin must call it off the JS thread (`StiqArtiModule` uses its lifecycleExecutor).
#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiStart(
    mut env: JNIEnv,
    _this: JObject,
    config_json: JString,
) -> jint {
    let Ok(json) = env.get_string(&config_json) else {
        return crate::codes::ERR_BAD_CONFIG;
    };
    crate::arti_start(String::from(json))
}

#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiStop(_env: JNIEnv, _this: JObject) {
    crate::arti_stop();
}

/// Install reach credentials into the LIVE client and kick the deferred reachability
/// verification — the second half of an early start (see lib.rs arti_install_auth). Returns 0 or
/// a negative `codes::*` value; `ERR_NOT_RUNNING` (-8) means "no live client, retry after
/// connected".
///
/// Blocking (keystore writes) — Kotlin must call it off the JS thread; StiqArtiModule routes it
/// through the same lifecycleExecutor as start/stop so it can never interleave with them.
#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiInstallAuth(
    mut env: JNIEnv,
    _this: JObject,
    reach_json: JString,
) -> jint {
    let Ok(json) = env.get_string(&reach_json) else {
        return crate::codes::ERR_BAD_CONFIG;
    };
    crate::arti_install_auth(String::from(json))
}

#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiNewIdentity(
    _env: JNIEnv,
    _this: JObject,
) {
    crate::arti_new_identity();
}

/// `true` to suspend background activity, `false` to resume — `dormancy.ts`'s
/// `setDormant`/`setActive` land here.
#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiSetDormant(
    _env: JNIEnv,
    _this: JObject,
    dormant: jboolean,
) {
    crate::arti_set_dormant(dormant != 0);
}

/// The HTTP CONNECT proxy port, or -1. Always -1 under Arti, which has no HTTP front; the WebView
/// path must read that as "reader mode only" rather than dialling it.
#[no_mangle]
pub extern "system" fn Java_com_stiq_client_StiqArtiModule_artiHttpPort(
    _env: JNIEnv,
    _this: JObject,
) -> jint {
    crate::arti_http_port()
}
