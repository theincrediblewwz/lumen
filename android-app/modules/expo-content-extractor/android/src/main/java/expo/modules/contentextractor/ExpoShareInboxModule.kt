package expo.modules.contentextractor

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

/** Copies shared streams into private cache before JS can inspect them. */
class ExpoShareInboxModule : Module() {
  private data class StagedFile(
    val name: String, val kind: String, val mediaType: String,
    val byteSize: Long, val sha256: String, val uri: String,
  ) {
    fun asMap() = mapOf(
      "name" to name, "kind" to kind, "mediaType" to mediaType,
      "byteSize" to byteSize, "sha256" to sha256, "uri" to uri,
    )
  }

  private class PendingShare(
    val id: String, val text: String, val subject: String,
    val mimeType: String, val uris: List<Uri>, var error: String? = null,
  ) {
    var staged = uris.isEmpty()
    var files: List<StagedFile> = emptyList()
    fun asMap() = mapOf(
      "id" to id, "text" to text, "subject" to subject, "mimeType" to mimeType,
      "error" to error, "staged" to staged, "fileCount" to uris.size,
      "files" to files.map { it.asMap() },
    )
  }

  private val queue = ArrayDeque<PendingShare>()
  private val stagingIds = mutableSetOf<String>()
  private var lastIntent: Intent? = null
  private var orphanCacheCleaned = false

  override fun definition() = ModuleDefinition {
    Name("ExpoShareInbox")
    Events("onShareReceived")

    Function("peekPendingShare") {
      cleanOrphanCache()
      capture(appContext.currentActivity?.intent)
      synchronized(queue) { queue.firstOrNull()?.asMap() }
    }

    AsyncFunction("stageShareAsync") { id: String ->
      val pending = synchronized(queue) {
        val first = queue.firstOrNull()
        if (first?.id != id) throw IllegalArgumentException("分享已结束或顺序已变化")
        if (first.staged || first.uris.isEmpty() || first.uris.size > MAX_FILES || first.text.toByteArray(Charsets.UTF_8).size > 8_000_000) {
          return@AsyncFunction first.asMap()
        }
        if (!stagingIds.add(id)) throw IllegalStateException("正在读取这条分享，请稍候")
        first
      }
      val directory = appContext.reactContext?.let { File(it.cacheDir, "share-inbox/$id") }
      try {
        val stagingDirectory = directory ?: throw IllegalStateException("应用文件目录不可用")
        if (!stagingDirectory.mkdirs() && !stagingDirectory.isDirectory) throw IllegalStateException("无法创建分享暂存目录")
        var totalBytes = 0L
        val copied = pending.uris.mapIndexed { index, uri ->
          val file = copySharedFile(uri, stagingDirectory, index, MAX_BATCH_BYTES - totalBytes)
          totalBytes += file.byteSize
          file
        }
        synchronized(queue) {
          if (queue.firstOrNull()?.id != id) throw IllegalStateException("分享已经取消")
          pending.files = copied
          pending.staged = true
          pending.error = null
          pending.asMap()
        }
      } catch (error: Exception) {
        directory?.deleteRecursively()
        synchronized(queue) {
          pending.files = emptyList()
          pending.staged = false
          pending.error = when (error) {
            is SecurityException -> "文件读取权限已失效，请从原应用重新分享"
            is IllegalArgumentException, is IllegalStateException -> error.message ?: "分享文件读取失败"
            else -> "分享文件无法读取，请检查原文件后重新分享"
          }
          pending.asMap()
        }
      } finally {
        synchronized(queue) { stagingIds.remove(id) }
      }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("finishShareAsync") { id: String ->
      val removed = synchronized(queue) {
        if (stagingIds.contains(id)) return@AsyncFunction false
        if (queue.firstOrNull()?.id == id) queue.removeFirst() else null
      }
      if (removed != null) {
        appContext.reactContext?.let { File(it.cacheDir, "share-inbox/$id").deleteRecursively() }
        if (synchronized(queue) { queue.isEmpty() }) {
          val activity = appContext.currentActivity
          if (activity != null && activity.intent === lastIntent) activity.intent = Intent(Intent.ACTION_MAIN)
        }
      }
      removed != null
    }.runOnQueue(Queues.MAIN)

    OnNewIntent { intent ->
      appContext.currentActivity?.intent = intent
      if (capture(intent)) sendEvent("onShareReceived", mapOf("available" to true))
    }
  }

  private fun capture(intent: Intent?): Boolean {
    if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return false
    val mime = intent.type.orEmpty().lowercase()
    val uris = sharedUris(intent)
    if (mime !in setOf("text/plain", "text/markdown", "application/pdf", "application/octet-stream")
      && !mime.startsWith("image/") && !(mime == "*/*" && uris.isNotEmpty())) return false
    synchronized(queue) {
      if (intent === lastIntent) return false
      cleanOrphanCache()
      lastIntent = intent
      if (queue.size >= 20) return false
      val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
      val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim()?.take(160).orEmpty()
      val error = when {
        uris.size > MAX_FILES -> "一次最多接收 10 个文件"
        uris.isEmpty() && text.isBlank() -> "分享内容没有可读取的文字或文件"
        uris.isEmpty() && mime !in setOf("text/plain", "text/markdown") -> "分享没有可读取的文件"
        text.toByteArray(Charsets.UTF_8).size > 8_000_000 -> "分享文字超过 8 MB 上限"
        else -> null
      }
      queue.addLast(PendingShare(UUID.randomUUID().toString(), text, subject, mime, uris, error))
      return true
    }
  }

  private fun cleanOrphanCache() {
    if (orphanCacheCleaned) return
    val context = appContext.reactContext ?: return
    orphanCacheCleaned = true
    File(context.cacheDir, "share-inbox").listFiles()?.forEach { it.deleteRecursively() }
  }

  @Suppress("DEPRECATION")
  private fun sharedUris(intent: Intent): List<Uri> {
    val collected = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val streams = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      streams?.let { collected.addAll(it) }
    } else {
      val stream = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      stream?.let { collected.add(it) }
    }
    intent.clipData?.let { clip ->
      for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { collected.add(it) }
    }
    return collected.distinctBy { it.toString() }
  }

  private fun copySharedFile(uri: Uri, directory: File, index: Int, remainingBytes: Long): StagedFile {
    if (uri.scheme != "content" && uri.scheme != "file") throw IllegalArgumentException("分享文件地址无效")
    val context = appContext.reactContext ?: throw IllegalStateException("应用文件目录不可用")
    val resolver = context.contentResolver
    var displayName: String? = null
    if (uri.scheme == "content") {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) displayName = it.getString(0)
      }
    }
    val name = cleanName(displayName ?: uri.lastPathSegment ?: "shared-${index + 1}")
    val path = File(directory, "$index-${UUID.randomUUID()}.part")
    val digest = MessageDigest.getInstance("SHA-256")
    var byteSize = 0L
    val header = ByteArray(16)
    var headerLength = 0
    resolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalArgumentException("文件读取权限已失效，请重新分享")
      FileOutputStream(path).use { output ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          byteSize += count
          if (byteSize > MAX_SYNC_BYTES) throw IllegalArgumentException("单文件超过可同步的 32 MiB 上限")
          if (byteSize > remainingBytes) throw IllegalArgumentException("分享文件合计超过 64 MiB")
          if (headerLength < header.size) {
            val copied = minOf(header.size - headerLength, count)
            buffer.copyInto(header, headerLength, 0, copied)
            headerLength += copied
          }
          digest.update(buffer, 0, count)
          output.write(buffer, 0, count)
        }
      }
    }
    if (byteSize == 0L) throw IllegalArgumentException("分享文件为空")
    val declaredType = resolver.getType(uri)?.lowercase() ?: ""
    val lowerName = name.lowercase()
    val (kind, mediaType, extension) = when {
      headerLength >= 5 && header.copyOfRange(0, 5).contentEquals("%PDF-".toByteArray()) -> Triple("pdf", "application/pdf", "pdf")
      headerLength >= 8 && header.copyOfRange(0, 8).contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)) -> Triple("image", "image/png", "png")
      headerLength >= 3 && header[0] == 0xFF.toByte() && header[1] == 0xD8.toByte() && header[2] == 0xFF.toByte() -> Triple("image", "image/jpeg", "jpg")
      headerLength >= 12 && String(header, 0, 4) == "RIFF" && String(header, 8, 4) == "WEBP" -> Triple("image", "image/webp", "webp")
      lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || declaredType == "text/markdown" -> Triple("markdown", "text/markdown", "md")
      lowerName.endsWith(".txt") || declaredType == "text/plain" -> Triple("text", "text/plain", "txt")
      else -> throw IllegalArgumentException("仅支持 PDF、JPEG/PNG/WebP 图片和 Markdown/文字文件")
    }
    val limit = when (kind) { "image" -> 20_000_000L; "text", "markdown" -> 8_000_000L; else -> MAX_SYNC_BYTES }
    if (byteSize > limit) throw IllegalArgumentException("${name} 超过${if (kind == "image") "图片 20 MB" else if (kind == "pdf") "PDF 32 MiB" else "文字 8 MB"}上限")
    if (kind == "text" || kind == "markdown") {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(path.readBytes()))
    }
    val finalFile = File(directory, "$index-${UUID.randomUUID()}.$extension")
    if (!path.renameTo(finalFile)) throw IllegalStateException("无法保存分享暂存文件")
    return StagedFile(name, kind, mediaType, byteSize, digest.digest().joinToString("") { "%02x".format(it) }, Uri.fromFile(finalFile).toString())
  }

  private fun cleanName(input: String): String {
    val name = input.substringAfterLast('/').substringAfterLast('\\')
      .replace(Regex("[^\\p{L}\\p{N}._ -]"), "_").trim(' ', '.').take(120)
    return name.ifBlank { "分享文件" }
  }

  companion object {
    private const val MAX_FILES = 10
    private const val MAX_SYNC_BYTES = 32L * 1024 * 1024
    private const val MAX_BATCH_BYTES = 64L * 1024 * 1024
  }
}
