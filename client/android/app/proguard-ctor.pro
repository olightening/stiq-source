# R8 keeps for the ctor flavor ONLY (wired via productFlavors.ctor.proguardFile in build.gradle).
# The arti flavor has none of these classes on its classpath, which is why they live here and not
# in proguard-rules.pro.

# Bundled Tor daemon + pluggable transports (loaded via JNI / service reflection).
-keep class org.torproject.** { *; }
-keep class IPtProxy.** { *; }

# StiqTorService (W2): subclass of TorService instantiated by the Android framework from the
# manifest <service> entry (reflective). AGP normally keeps manifest components, but keep it
# explicitly since it extends a keep-listed AAR class and is the only foreground-promotion path
# for the daemon.
-keep class com.stiq.client.StiqTorService { *; }
