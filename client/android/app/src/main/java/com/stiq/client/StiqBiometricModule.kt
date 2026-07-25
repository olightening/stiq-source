package com.stiq.client

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicBoolean

/**
 * StiqBiometric — gates the in-app password vault behind a BiometricPrompt.
 *
 * Allowed authenticators are BIOMETRIC_STRONG | DEVICE_CREDENTIAL, so the OS device
 * PIN/pattern/password is the built-in fallback when no fingerprint/face is enrolled — matching the
 * product's "biometric, with PIN fallback" unlock. The app's own PIN (PinVault) is a further
 * fallback handled in JS when this module reports unavailable.
 */
class StiqBiometricModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StiqBiometric"

    private val authenticators =
        BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

    @ReactMethod
    fun isAvailable(promise: Promise) {
        val status = BiometricManager.from(reactContext).canAuthenticate(authenticators)
        promise.resolve(status == BiometricManager.BIOMETRIC_SUCCESS)
    }

    @ReactMethod
    fun authenticate(reason: String, promise: Promise) {
        val activity = currentActivity as? FragmentActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        // A Promise resolves exactly once; guard against the (rare) case where success and a later
        // error/cancel callback both fire.
        val settled = AtomicBoolean(false)
        fun finish(ok: Boolean) {
            if (settled.compareAndSet(false, true)) promise.resolve(ok)
        }

        activity.runOnUiThread {
            val executor = ContextCompat.getMainExecutor(reactContext)
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        finish(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        finish(false)
                    }
                    // onAuthenticationFailed (one bad attempt) is intentionally ignored — the prompt
                    // stays open so the user can retry until they succeed or cancel.
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock your vault")
                .setSubtitle(reason)
                .setAllowedAuthenticators(authenticators)
                .build()
            try {
                prompt.authenticate(info)
            } catch (e: Exception) {
                finish(false)
            }
        }
    }
}
