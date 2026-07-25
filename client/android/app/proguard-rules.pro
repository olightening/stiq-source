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

# Bundled Tor daemon + pluggable transports (loaded via JNI / service reflection).
-keep class org.torproject.** { *; }
-keep class IPtProxy.** { *; }

# StiqTorService (W2): subclass of TorService instantiated by the Android framework from the manifest
# <service> entry (reflective). AGP normally keeps manifest components, but keep it explicitly since it
# extends a keep-listed AAR class and is the only foreground-promotion path for the daemon.
-keep class com.stiq.client.StiqTorService { *; }

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
