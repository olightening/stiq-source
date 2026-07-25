package com.stiq.client

import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup

/**
 * A ReactViewGroup that suppresses the Android text-selection toolbar — the floating
 * Cut/Copy/Paste/Translate bar (the "CAB") — for every descendant view, WITHOUT losing the
 * selection itself.
 *
 * WHY a parent view: a child View's `startActionMode()` is dispatched up the hierarchy via the
 * parent's `startActionModeForChild()` (View.startActionMode → parent.startActionModeForChild). By
 * intercepting BOTH overloads here we catch every path — even for `contenteditable` content, where
 * the WebView's own `menuItems` override is unreliable (react-native-webview issue #3774, and
 * RNCWebView only overrides the 2-arg `startActionMode`). This is the WebView equivalent of how
 * native apps replace the selection toolbar (Telegram et al. use `setCustomSelectionActionModeCallback`
 * on their EditTexts — not available for a WebView).
 *
 * WHY NOT return null: an earlier version returned null from both overloads. That killed the toolbar
 * but ALSO killed the selection — Chromium's SelectionPopupController starts the toolbar via
 * `showActionModeOrClearOnFailure()`, so a null (== "couldn't start") makes it CLEAR the selection.
 * The visible symptom was the selection + our bubble blipping and vanishing the instant you selected.
 *
 * THE FIX: still start a real ActionMode (so the selection is kept), but wrap the caller's callback
 * so the menu is emptied every time it's populated — a toolbar with zero items renders nothing. The
 * selection, its drag handles, and our in-editor bubble all stay; only the OS toolbar is gone. We
 * delegate the lifecycle calls to the original callback so the selection controller's own bookkeeping
 * (e.g. clearing on tap-away) keeps working.
 */
class NoCabView(context: ThemedReactContext) : ReactViewGroup(context) {
  override fun startActionModeForChild(originalView: View?, callback: ActionMode.Callback?): ActionMode? =
    super.startActionModeForChild(originalView, EmptyMenuCallback(callback))

  override fun startActionModeForChild(
    originalView: View?,
    callback: ActionMode.Callback?,
    type: Int,
  ): ActionMode? = super.startActionModeForChild(originalView, EmptyMenuCallback(callback), type)

  /**
   * Wraps the selection controller's callback: forwards every lifecycle call to it, but strips all
   * menu items so the floating toolbar has nothing to show. onCreate/onPrepare return true so the
   * ActionMode is actually created (non-null) — that is what preserves the selection.
   */
  private class EmptyMenuCallback(private val inner: ActionMode.Callback?) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
      inner?.onCreateActionMode(mode, menu)
      menu?.clear()
      return true
    }

    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean {
      inner?.onPrepareActionMode(mode, menu)
      menu?.clear()
      return true
    }

    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean =
      inner?.onActionItemClicked(mode, item) ?: false

    override fun onDestroyActionMode(mode: ActionMode?) {
      inner?.onDestroyActionMode(mode)
    }

    override fun onGetContentRect(mode: ActionMode?, view: View?, outRect: Rect?) {
      if (inner is ActionMode.Callback2) {
        inner.onGetContentRect(mode, view, outRect)
      } else {
        super.onGetContentRect(mode, view, outRect)
      }
    }
  }
}
