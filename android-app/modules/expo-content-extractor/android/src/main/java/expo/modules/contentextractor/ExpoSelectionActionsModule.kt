package expo.modules.contentextractor

import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** Adds actions only to mounted reader cells. Does not replace selection or clipboard behavior. */
class ExpoSelectionActionsModule : Module() {
  private data class Binding(val view: WeakReference<TextView>, val previous: ActionMode.Callback?, val installed: ActionMode.Callback)
  private val bindings = mutableMapOf<String, MutableList<Binding>>()
  private val actions = listOf("explain" to "解释", "example" to "举例", "ask" to "追问")
  private val firstId = 0x4c530001

  override fun definition() = ModuleDefinition {
    Name("ExpoSelectionActions")
    Events("onSelectionAction")
    AsyncFunction("bind") { tag: Int, key: String ->
      release(key)
      val root = appContext.findView<View>(tag)
      val list = mutableListOf<Binding>()
      fun visit(view: View) {
        if (view is TextView && view !is EditText && view.isTextSelectable) {
          val previous = view.customSelectionActionModeCallback
          val callback = object : ActionMode.Callback {
            fun add(menu: Menu) {
              actions.forEachIndexed { index, action ->
                if (menu.findItem(firstId + index) == null) menu.add(Menu.NONE, firstId + index, index, action.second).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
              }
            }
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
              if (previous?.onCreateActionMode(mode, menu) == false) return false
              add(menu); return true
            }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
              previous?.onPrepareActionMode(mode, menu); add(menu); return true
            }
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
              val index = item.itemId - firstId
              if (index !in actions.indices) return previous?.onActionItemClicked(mode, item) ?: false
              val text = view.text?.toString() ?: return true
              val start = minOf(view.selectionStart, view.selectionEnd)
              val end = maxOf(view.selectionStart, view.selectionEnd)
              if (start >= 0 && end > start && end <= text.length) {
                sendEvent("onSelectionAction", mapOf("key" to key, "action" to actions[index].first,
                  "quote" to text.substring(start, minOf(end, start + 2401)),
                  "before" to text.substring(maxOf(0, start - 400), start),
                  "after" to text.substring(end, minOf(text.length, end + 400))))
                mode.finish()
              }
              return true
            }
            override fun onDestroyActionMode(mode: ActionMode) { previous?.onDestroyActionMode(mode) }
          }
          view.customSelectionActionModeCallback = callback
          list.add(Binding(WeakReference(view), previous, callback))
        }
        if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
      }
      if (root != null) visit(root)
      bindings[key] = list
      list.size
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("unbind") { key: String -> release(key) }.runOnQueue(Queues.MAIN)
  }
  private fun release(key: String) {
    bindings.remove(key)?.forEach { binding ->
      binding.view.get()?.let { view ->
        if (view.customSelectionActionModeCallback === binding.installed) view.customSelectionActionModeCallback = binding.previous
      }
    }
  }
}
