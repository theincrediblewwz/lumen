package expo.modules.contentextractor

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist
import java.io.File
import java.net.URLDecoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal object RichDocuments {
  val cancelled = ConcurrentHashMap.newKeySet<String>()
  private fun localFile(context: Context, value: String): File {
    val uri=Uri.parse(value)
    require(uri.scheme=="file") {"只读取已复制到应用内的原件"}
    val file=File(uri.path ?: "").canonicalFile
    require(listOf(context.filesDir,context.cacheDir).any { file.path.startsWith(it.canonicalPath+File.separator) }) {"原件不在应用资料目录"}
    require(file.isFile && file.length()<=32L*1024*1024) {"原件不存在或超过32MiB"}
    return file
  }
  fun inspect(context:Context, uri:String, token:String):List<Map<String,Any>> {
    PDFBoxResourceLoader.init(context);val pages=mutableListOf<Map<String,Any>>();val deadline=System.currentTimeMillis()+120_000;var total=0
    try {PDDocument.load(localFile(context,uri)).use {doc ->
      require(!doc.isEncrypted && doc.numberOfPages<=2000){"PDF加密或超过2000页处理预算"}
      for(page in 1..doc.numberOfPages){require(!cancelled.contains(token)&&System.currentTimeMillis()<deadline){"已停止PDF预检，尚未挂载"}
        val text=PDFTextStripper().apply{startPage=page;endPage=page;sortByPosition=true}.getText(doc).trim();total+=text.length;require(total<=1_000_000){"PDF文字超过100万字符，请拆分"};pages.add(mapOf("page" to page,"text" to text))
      }
    };return pages}finally{cancelled.remove(token)}
  }
  fun render(context:Context,uri:String,index:Int,width:Int):Map<String,Any>{
    ParcelFileDescriptor.open(localFile(context,uri),ParcelFileDescriptor.MODE_READ_ONLY).use {fd -> PdfRenderer(fd).use {pdf ->
      require(index in 0 until pdf.pageCount){"页码无效"};pdf.openPage(index).use {page ->
        val w=width.coerceIn(240,2048);val height=w.toDouble()*page.height/page.width;require(height.isFinite()&&height in 1.0..16384.0&&w*height<=8_000_000){"页面尺寸超过显示预算"}
        val bitmap=Bitmap.createBitmap(w,height.toInt(),Bitmap.Config.ARGB_8888)
        try {bitmap.eraseColor(Color.WHITE);page.render(bitmap,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          val folder=File(context.cacheDir,"rich-pdf-pages").apply{mkdirs()};val output=File(folder,UUID.randomUUID().toString()+".png");output.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
          return mapOf("uri" to Uri.fromFile(output).toString(),"width" to w,"height" to bitmap.height,"pages" to pdf.pageCount)
        }finally{bitmap.recycle()}
      }
    }}
  }
  fun sanitize(html:String,aliases:Map<String,String>):String {
    require(html.length<=4_000_000){"排版内容超过预算"};val parsed=Jsoup.parseBodyFragment(html)
    parsed.select("script,style,link,iframe,object,embed,form,input,button,video,audio,source,template").remove()
    for(image in parsed.select("img")){
      val raw=image.attr("src");val alias=try{URLDecoder.decode(raw.replace("+","%2B"),"UTF-8").removePrefix("./")}catch(_:Exception){""}
      val hash=aliases[alias];image.clearAttributes()
      if(hash!=null&&Regex("[a-f0-9]{64}").matches(hash)){image.attr("data-lumen-image",hash)}else{image.attr("alt","[图片未随资料提供]")}
    }
    val safe=Safelist.relaxed().addTags("math","semantics","annotation","mrow","mi","mn","mo","mfrac","msup","msub","msubsup","msqrt","mroot","mtable","mtr","mtd","mtext","munder","mover","munderover","menclose","mspace","mpadded","mstyle")
      .removeAttributes(":all","style","background").removeAttributes("img","src","width","height")
      .addAttributes("img","data-lumen-image","alt").addAttributes("math","display","xmlns").addAttributes("annotation","encoding").addAttributes("td","rowspan","colspan").addAttributes("th","rowspan","colspan")
    return Jsoup.clean(parsed.body().html(),safe)
  }
}
