package expo.modules.contentextractor

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.android.gms.tasks.Tasks
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.rendering.ImageType
import com.tom_roush.pdfbox.rendering.PDFRenderer
import com.tom_roush.pdfbox.text.PDFTextStripper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoContentExtractorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoContentExtractor")

    AsyncFunction("extractPdfPagesAsync") { uriValue: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      PDFBoxResourceLoader.init(context)
      val uri = Uri.parse(uriValue)
      val pages = mutableListOf<Map<String, Any>>()
      var extractedCharacters = 0

      context.contentResolver.openInputStream(uri).use { input ->
        if (input == null) throw IllegalArgumentException("Unable to open the selected PDF")
        PDDocument.load(input).use { document ->
          if (document.numberOfPages > 500) {
            throw IllegalArgumentException("PDF exceeds the 500-page safety limit")
          }
          val renderer = PDFRenderer(document)
          val recognizer = TextRecognition.getClient(
            ChineseTextRecognizerOptions.Builder().build()
          )
          var scannedPages = 0
          try {
            for (pageNumber in 1..document.numberOfPages) {
              val stripper = PDFTextStripper().apply {
                startPage = pageNumber
                endPage = pageNumber
                sortByPosition = true
              }
              var text = stripper.getText(document).trim()
              var usedOcr = false
              if (text.isBlank()) {
                usedOcr = true
                scannedPages += 1
                if (scannedPages > 80) {
                  throw IllegalArgumentException("Scanned PDF exceeds the 80-page OCR safety limit")
                }
                val bitmap = renderer.renderImageWithDPI(pageNumber - 1, 144f, ImageType.RGB)
                try {
                  val pixels = bitmap.width.toLong() * bitmap.height.toLong()
                  if (pixels > 40_000_000L) {
                    throw IllegalArgumentException("Rendered PDF page exceeds the 40-megapixel safety limit")
                  }
                  text = Tasks.await(
                    recognizer.process(InputImage.fromBitmap(bitmap, 0))
                  ).text.trim()
                } finally {
                  bitmap.recycle()
                }
              }
              extractedCharacters += text.length
              if (extractedCharacters > 2_000_000) {
                throw IllegalArgumentException("PDF extracted text exceeds the 2,000,000-character safety limit")
              }
              pages.add(mapOf(
                "page" to pageNumber,
                "text" to text,
                "extraction" to if (text.isBlank()) "empty" else if (usedOcr) "ocr" else "text"
              ))
            }
          } finally {
            recognizer.close()
          }
        }
      }
      pages
    }

    AsyncFunction("recognizeImageTextAsync") { uriValue: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("context_unavailable", "Android context is unavailable", null)
        return@AsyncFunction
      }
      val image = try {
        InputImage.fromFilePath(context, Uri.parse(uriValue))
      } catch (error: Exception) {
        promise.reject("image_open_failed", "Unable to open the selected image", error)
        return@AsyncFunction
      }
      val pixels = image.width.toLong() * image.height.toLong()
      if (pixels > 40_000_000L) {
        promise.reject("image_too_large", "Image exceeds the 40-megapixel safety limit", null)
        return@AsyncFunction
      }
      val recognizer = TextRecognition.getClient(
        ChineseTextRecognizerOptions.Builder().build()
      )
      recognizer.process(image)
        .addOnSuccessListener { result ->
          recognizer.close()
          if (result.text.length > 500_000) {
            promise.reject("ocr_text_too_large", "Recognized text exceeds the 500,000-character safety limit", null)
          } else {
            promise.resolve(result.text)
          }
        }
        .addOnFailureListener { error ->
          recognizer.close()
          promise.reject("ocr_failed", "Text recognition failed", error)
        }
    }
  }
}
