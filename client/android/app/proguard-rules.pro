# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ── Keeps for a minified release build (minifyEnabled + shrinkResources) ──────────────────────────
# R8 cannot see classes reached only via reflection or JNI, so it would strip them and the release
# APK would crash at runtime where a debug APK (never minified) works. These are the non-framework
# reflection/JNI entry points this app relies on. (React Native's bundled proguard-android.txt
# already keeps the RN framework, @DoNotStrip/JNI classes, Hermes and the JS bridge.)

# This app's native modules — registered from Kotlin and bridged by name from JS, so keep the
# module + package classes and their members intact.
-keep class com.stiq.client.**Module { *; }
-keep class com.stiq.client.**Package { *; }

# op-sqlite (SQLCipher) — the encrypted event store's native adapter. op-sqlite v11 lives in
# `com.op.sqlite`; the JSI bridge declares `external` (JNI native) methods, so keep the whole tree.
-keep class com.op.** { *; }
-keep class io.requery.android.database.** { *; }

# WorkManager instantiates SyncWorker via reflection through its default WorkerFactory, calling the
# (Context, WorkerParameters) constructor by name. R8 keeps the SyncWorker CLASS because
# StiqWorkManagerModule references it directly (PeriodicWorkRequestBuilder<SyncWorker>), but the
# reflectively-invoked constructor is otherwise unreachable and would be stripped/renamed — the
# periodic background sync (offline-first drain over Tor) would then silently never run in release.
# (A transitive consumer rule from @notifee also covers this, but our own background sync must not
# depend on a third-party dependency continuing to ship it.)
-keepclassmembers class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# StiqArtiModule (StiqArtiModule.kt) binds to Arti's Rust JNI bridge (arti-ffi/src/jni_bridge.rs)
# via STATIC JNI symbol names baked into the compiled .so at build time — e.g.
# `Java_com_stiq_client_StiqArtiModule_artiStart` — not JNI_OnLoad/RegisterNatives. If R8 renames
# the class or any of its `external fun` methods (artiStart/artiStop/artiNewIdentity/
# artiSetDormant/artiHttpPort/artiRegisterCallback), the .so's exported symbols no longer match
# what the JVM looks up and Tor never starts: UnsatisfiedLinkError, release-only, since debug is
# never minified. proguard-android.txt's bundled `-keepclasseswithmembernames class * { native
# <methods>; }` already covers any class with a native method regardless of R8 mode — this rule
# restates it scoped to the one class where it actually matters, so the JNI binding keeps working
# even if that default-file reference is ever swapped out from under it.
-keepclasseswithmembernames,includedescriptorclasses class com.stiq.client.StiqArtiModule {
    native <methods>;
}
