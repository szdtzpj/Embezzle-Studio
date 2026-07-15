package expo.modules.embezzledocumentimport

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.rendering.ImageType
import com.tom_roush.pdfbox.rendering.PDFRenderer
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.math.min
import kotlin.math.sqrt

private const val MAX_FILE_BYTES = 20_000_000L
private const val DEFAULT_MAX_PAGES = 200
private const val DEFAULT_MAX_CHARACTERS = 500_000
private const val MAX_IMAGE_PIXELS = 40_000_000L
private const val MAX_IMAGE_DIMENSION = 8_192
private const val MAX_RENDER_PIXELS = 12_000_000L
private const val MAX_RENDER_DIMENSION = 8_192
private const val MIN_RENDER_DPI = 24.0
private const val MAX_RENDER_DPI = 200

class EmbezzleDocumentImportModule : Module() {
  private var pdfLoaderInitialized = false

  override fun definition() = ModuleDefinition {
    Name("EmbezzleDocumentImport")

    Constants(
      "isPdfSupported" to true,
      "isOcrSupported" to true,
    )

    AsyncFunction("extractPdfText") { uriString: String, options: Map<String, Any?>? ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "Android 上下文不可用。", null)
      val maxPages = boundedPositiveInt(options?.get("maxPages"), DEFAULT_MAX_PAGES)
      val maxCharacters = boundedPositiveInt(options?.get("maxCharacters"), DEFAULT_MAX_CHARACTERS)
      val source = materializeSourceFile(context, uriString, ".pdf")
      try {
        ensurePdfLoader(context)
        PDDocument.load(source.file).use { document ->
          if (document.isEncrypted) {
            throw CodedException("ENCRYPTED_PDF", "PDF 受密码保护，未尝试绕过密码。", null)
          }
          val pageCount = document.numberOfPages
          val pages = ArrayList<Map<String, Any?>>()
          var remaining = maxCharacters
          val pageLimit = min(pageCount, maxPages)
          val stripper = com.tom_roush.pdfbox.text.PDFTextStripper()
          for (pageIndex in 0 until pageLimit) {
            val text = if (remaining > 0) {
              stripper.startPage = pageIndex + 1
              stripper.endPage = pageIndex + 1
              val raw = stripper.getText(document).trim()
              val bounded = if (raw.length > remaining) raw.substring(0, remaining) else raw
              remaining -= bounded.length
              bounded
            } else {
              // Keep later pages visible as blank OCR targets after the text
              // budget is exhausted; do not silently hide them.
              ""
            }
            pages.add(mapOf("pageNumber" to pageIndex + 1, "text" to text))
          }
          mapOf(
            "pageCount" to pageCount,
            "hasTextLayer" to pages.any { (it["text"] as? String).orEmpty().isNotBlank() },
            "pages" to pages,
            "warnings" to buildList {
              if (pageCount > maxPages) add("PDF 页数超过安全上限，后续页面未进入预览。")
              if (remaining <= 0) add("PDF 正文超过安全字符上限，后续内容未进入预览。")
            },
          )
        }
      } finally {
        source.cleanup()
      }
    }

    AsyncFunction("renderPdfPage") { uriString: String, pageNumber: Int, dpi: Int? ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "Android 上下文不可用。", null)
      if (pageNumber < 1 || pageNumber > DEFAULT_MAX_PAGES) {
        throw CodedException("PAGE_LIMIT", "PDF 页码超出安全范围。", null)
      }
      val source = materializeSourceFile(context, uriString, ".pdf")
      try {
        ensurePdfLoader(context)
        PDDocument.load(source.file).use { document ->
          if (document.isEncrypted) throw CodedException("ENCRYPTED_PDF", "PDF 受密码保护。", null)
          if (pageNumber > document.numberOfPages) throw CodedException("PAGE_NOT_FOUND", "PDF 页码不存在。", null)
          val renderDpi = safeRenderDpi(document, pageNumber, dpi ?: 144)
          val bitmap = PDFRenderer(document).renderImageWithDPI(pageNumber - 1, renderDpi, ImageType.RGB)
          val width = bitmap.width
          val height = bitmap.height
          if (width.toLong() * height.toLong() > MAX_RENDER_PIXELS ||
            width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION
          ) {
            bitmap.recycle()
            throw CodedException(
              "RENDER_LIMIT",
              "PDF render result exceeds the safe size limit.",
              null,
            )
          }
          val output = File(context.cacheDir, "embezzle-pdf-${UUID.randomUUID()}.png")
          try {
            FileOutputStream(output).use { stream ->
              if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                throw CodedException("RENDER_WRITE_FAILED", "Unable to write the rendered PDF page.", null)
              }
            }
            mapOf("uri" to Uri.fromFile(output).toString(), "width" to width, "height" to height)
          } catch (error: Exception) {
            output.delete()
            throw error
          } finally {
            bitmap.recycle()
          }
        }
      } finally {
        source.cleanup()
      }
    }

    AsyncFunction("recognizeImageText") { uriString: String, script: String? ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "Android 上下文不可用。", null)
      val uri = parseInputUri(uriString)
      ensureInputImageBounds(context, uri)
      val image = try {
        InputImage.fromFilePath(context, uri)
      } catch (error: Exception) {
        throw CodedException("IMAGE_READ_FAILED", "无法读取待识别图片。", error)
      }
      val options = if (script.equals("Latin", ignoreCase = true)) {
        TextRecognizerOptions.DEFAULT_OPTIONS
      } else {
        ChineseTextRecognizerOptions.Builder().build()
      }
      val recognizer = TextRecognition.getClient(options)
      try {
        val result = Tasks.await(recognizer.process(image))
        mapOf(
          "text" to result.text,
          "blocks" to result.textBlocks.map { blockToMap(it) },
        )
      } catch (error: Exception) {
        throw CodedException("OCR_FAILED", "本机 OCR 失败，请检查图片清晰度或改用显式服务商 OCR。", error)
      } finally {
        recognizer.close()
      }
    }
  }

  private fun ensurePdfLoader(context: Context) {
    if (!pdfLoaderInitialized) {
      synchronized(this) {
        if (!pdfLoaderInitialized) {
          PDFBoxResourceLoader.init(context.applicationContext)
          pdfLoaderInitialized = true
        }
      }
    }
  }

  private fun boundedPositiveInt(value: Any?, fallback: Int): Int {
    val number = when (value) {
      is Number -> value.toInt()
      else -> fallback
    }
    return number.coerceIn(1, fallback)
  }

  private fun safeRenderDpi(document: PDDocument, pageNumber: Int, requestedDpi: Int): Float {
    val mediaBox = document.getPage(pageNumber - 1).mediaBox
    val widthPoints = mediaBox.width.toDouble().coerceAtLeast(1.0)
    val heightPoints = mediaBox.height.toDouble().coerceAtLeast(1.0)
    val requested = requestedDpi.coerceIn(48, MAX_RENDER_DPI).toDouble()
    val pixelDpi = sqrt(MAX_RENDER_PIXELS.toDouble() * 72.0 * 72.0 / (widthPoints * heightPoints))
    val dimensionDpi = min(
      MAX_RENDER_DIMENSION.toDouble() * 72.0 / widthPoints,
      MAX_RENDER_DIMENSION.toDouble() * 72.0 / heightPoints,
    )
    val safeDpi = min(requested, min(pixelDpi, dimensionDpi))
    if (!safeDpi.isFinite() || safeDpi < MIN_RENDER_DPI) {
      throw CodedException(
        "RENDER_LIMIT",
        "PDF page dimensions exceed the safe local-rendering limit.",
        null,
      )
    }
    return safeDpi.toFloat()
  }

  private data class MaterializedSource(val file: File, val cleanup: () -> Unit)

  private fun materializeSourceFile(context: Context, uriString: String, suffix: String): MaterializedSource {
    val uri = parseInputUri(uriString)
    if (uri.scheme == "file") {
      val file = File(uri.path ?: throw CodedException("INVALID_URI", "文件路径无效。", null))
      if (!file.exists() || file.length() > MAX_FILE_BYTES) throw CodedException("FILE_LIMIT", "文件不存在或超过安全大小上限。", null)
      return MaterializedSource(file) {}
    }
    val input = context.contentResolver.openInputStream(uri)
      ?: throw CodedException("FILE_READ_FAILED", "无法读取系统文档 URI。", null)
    val target = File(context.cacheDir, "embezzle-import-${UUID.randomUUID()}$suffix")
    try {
      input.use { source ->
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = source.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_FILE_BYTES) throw CodedException("FILE_LIMIT", "文件超过安全大小上限。", null)
            output.write(buffer, 0, count)
          }
        }
      }
    } catch (error: Exception) {
      target.delete()
      throw error
    }
    return MaterializedSource(target) { target.delete() }
  }

  private fun ensureInputImageBounds(context: Context, uri: Uri) {
    val declaredByteLength = when (uri.scheme) {
      "file" -> File(uri.path ?: "").length()
      "content" -> context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
      else -> -1L
    }
    if (declaredByteLength > MAX_FILE_BYTES) {
      throw CodedException("FILE_LIMIT", "Image exceeds the safe file-size limit.", null)
    }
    if (declaredByteLength < 0L && streamExceedsLimit(context, uri)) {
      throw CodedException("FILE_LIMIT", "Image exceeds the safe file-size limit.", null)
    }

    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    when (uri.scheme) {
      "file" -> BitmapFactory.decodeFile(uri.path, options)
      "content" -> {
        val input = context.contentResolver.openInputStream(uri)
          ?: throw CodedException("IMAGE_READ_FAILED", "Unable to open the image URI.", null)
        input.use { BitmapFactory.decodeStream(it, null, options) }
      }
    }
    val width = options.outWidth
    val height = options.outHeight
    if (
      width <= 0 ||
      height <= 0 ||
      width > MAX_IMAGE_DIMENSION ||
      height > MAX_IMAGE_DIMENSION ||
      width.toLong() * height.toLong() > MAX_IMAGE_PIXELS
    ) {
      throw CodedException("IMAGE_LIMIT", "Image dimensions exceed the local OCR limit.", null)
    }
  }

  private fun streamExceedsLimit(context: Context, uri: Uri): Boolean {
    val input = context.contentResolver.openInputStream(uri)
      ?: throw CodedException("IMAGE_READ_FAILED", "Unable to open the image URI.", null)
    return input.use { source ->
      val buffer = ByteArray(64 * 1024)
      var total = 0L
      var exceeded = false
      while (true) {
        val count = source.read(buffer)
        if (count < 0) break
        total += count
        if (total > MAX_FILE_BYTES) {
          exceeded = true
          break
        }
      }
      exceeded
    }
  }

  private fun parseInputUri(value: String): Uri {
    val uri = Uri.parse(value)
    if (uri.scheme.isNullOrBlank()) {
      val file = File(value)
      if (!file.exists()) throw CodedException("INVALID_URI", "文件路径无效。", null)
      return Uri.fromFile(file)
    }
    if (uri.scheme != "file" && uri.scheme != "content") {
      throw CodedException("INVALID_URI", "仅允许本地 file/content URI。", null)
    }
    return uri
  }

  private fun blockToMap(block: Text.TextBlock): Map<String, Any?> {
    val bounds: Rect? = block.boundingBox
    return mapOf(
      "text" to block.text,
      "left" to bounds?.left,
      "top" to bounds?.top,
      "width" to bounds?.width(),
      "height" to bounds?.height(),
    )
  }
}
