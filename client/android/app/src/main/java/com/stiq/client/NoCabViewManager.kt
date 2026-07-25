package com.stiq.client

import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * ViewManager for {@link NoCabView}, exposed to JS as the native component "StiqNoCabView".
 *
 * It extends ReactViewManager so the container behaves exactly like a normal <View> for all style
 * props (background, border radius, overflow, layout) — the only difference is the suppressed
 * selection toolbar. JS wraps the editor WebView in it (RichEditor.tsx).
 */
class NoCabViewManager : ReactViewManager() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = NoCabView(context)

  companion object {
    const val REACT_CLASS = "StiqNoCabView"
  }
}
