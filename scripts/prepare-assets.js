const fs = require('fs');
const path = require('path');

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('Copied:', dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log('Copied directory:', dest);
}

function prepareWebAssets() {
  if (fs.existsSync('index.html')) {
    copyFile('index.html', 'www/index.html');
  } else if (!fs.existsSync('www/index.html')) {
    throw new Error('Missing index.html in root or www/');
  }

  if (fs.existsSync('app-icon.png')) {
    copyFile('app-icon.png', 'www/app-icon.png');
  }

  const libs = [
    ['node_modules/pdfjs-dist/build/pdf.min.js', 'www/vendor/pdf.min.js'],
    ['node_modules/pdfjs-dist/build/pdf.worker.min.js', 'www/vendor/pdf.worker.min.js'],
    ['node_modules/mammoth/mammoth.browser.min.js', 'www/vendor/mammoth.browser.min.js'],
    ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'www/vendor/pdf-lib.min.js'],
    ['node_modules/jspdf/dist/jspdf.umd.min.js', 'www/vendor/jspdf.umd.min.js'],
    ['node_modules/html2canvas/dist/html2canvas.min.js', 'www/vendor/html2canvas.min.js']
  ];

  for (const [src, dest] of libs) {
    if (!fs.existsSync(src)) {
      throw new Error('Missing required offline library file: ' + src);
    }
    copyFile(src, dest);
    if (fs.statSync(dest).size < 1024) {
      throw new Error('Bundled library looks corrupt or empty: ' + dest);
    }
  }

  const fontPkgs = [
    ['node_modules/@fontsource/noto-sans-bengali', 'www/fonts/noto-sans-bengali'],
    ['node_modules/@fontsource/hind-siliguri', 'www/fonts/hind-siliguri']
  ];

  for (const [src, dest] of fontPkgs) {
    if (!fs.existsSync(src)) {
      throw new Error('Missing required offline font package: ' + src);
    }
    copyDir(src, dest);
  }

  const html = fs.readFileSync('www/index.html', 'utf8');
  if (html.includes('cdn.jsdelivr.net') || html.includes('fonts.googleapis.com')) {
    throw new Error('Offline integrity violation: external CDN link detected in www/index.html');
  }

  console.log('All offline web assets & Bengali fonts verified and bundled!');
}

function patchAndroidNative() {
  const pkgPath = 'android/app/src/main/java/com/aetherx/pdfreader';
  if (!fs.existsSync(pkgPath)) {
    throw new Error('Android package path not found: ' + pkgPath);
  }

  // 1. NativeStorageBridge.java (Includes "Open With" Content/File URI Handler + Print-to-PDF + Byte-Range Streaming)
  const nativeBridgeJava = `package com.aetherx.pdfreader;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class NativeStorageBridge {
    private final MainActivity activity;
    private static final String PREFS_NAME = "AetherXOwnerPrefs";
    private static final String KEY_OWNER_NAME = "owner_name";
    private final ExecutorService scanExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService intentExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger scanGeneration = new AtomicInteger(0);
    private final ConcurrentHashMap<String, RandomAccessFile> pdfSessions = new ConcurrentHashMap<>();
    private volatile String lastScanJson = "[]";
    private volatile String pendingExternalFileJson = "";
    private WebView activePrintWebView = null;

    private static final Set<String> SKIP_DIRS = new HashSet<>(Arrays.asList(
        "dcim", "pictures", "movies", "music", "ringtones", "alarms",
        "notifications", "podcasts", "audiobooks", "recordings", "miui",
        "whatsapp images", "whatsapp video", "whatsapp audio",
        "whatsapp voice notes", "whatsapp stickers", "whatsapp animated gifs",
        "telegram images", "telegram video", "telegram audio", "thumbnails", "cache"
    ));

    public NativeStorageBridge(MainActivity activity) {
        this.activity = activity;
    }

    public void cleanup() {
        closeAllPdfSessions();
        scanExecutor.shutdownNow();
        intentExecutor.shutdownNow();
    }

    private File getIncomingCacheDir() {
        File dir = new File(activity.getCacheDir(), "incoming_docs");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    // Validates external storage files (with permission) OR explicit incoming "Open With" cached files
    private File validateReadableFile(String rawPath) {
        if (rawPath == null || rawPath.trim().isEmpty()) return null;
        if (rawPath.contains("\\0")) return null;
        try {
            File target = new File(rawPath);
            if (!target.exists() || !target.isFile() || !target.canRead()) return null;
            String targetCanon = target.getCanonicalPath();

            File incomingDir = getIncomingCacheDir();
            String incomingCanon = incomingDir.getCanonicalPath();
            if (targetCanon.startsWith(incomingCanon + File.separator)) {
                return target;
            }

            if (!hasStoragePermission()) return null;
            File extRoot = Environment.getExternalStorageDirectory();
            if (extRoot == null) return null;
            String rootCanon = extRoot.getCanonicalPath();
            if (targetCanon.equals(rootCanon) || targetCanon.startsWith(rootCanon + File.separator)) {
                return target;
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private String sanitizeFilename(String rawName) {
        if (rawName == null) return "AetherX_File";
        String clean = rawName.replace("\\\\", "/");
        int slash = clean.lastIndexOf('/');
        if (slash >= 0) clean = clean.substring(slash + 1);
        clean = clean.replace("..", "_").replaceAll("[\\r\\n\\t\\0<>:\\"|?*]", "_").trim();
        if (clean.isEmpty() || clean.equals(".")) clean = "AetherX_File";
        if (clean.length() > 140) clean = clean.substring(0, 140);
        return clean;
    }

    private String inferExtension(String displayName, String mimeType) {
        if (displayName != null) {
            int dot = displayName.lastIndexOf('.');
            if (dot >= 0 && dot < displayName.length() - 1) {
                String ext = displayName.substring(dot + 1).toLowerCase(Locale.ROOT);
                if (isSupportedDoc("x." + ext)) return ext;
            }
        }
        if (mimeType != null) {
            String m = mimeType.toLowerCase(Locale.ROOT);
            if (m.contains("pdf")) return "pdf";
            if (m.contains("wordprocessingml")) return "docx";
            if (m.contains("msword")) return "doc";
            if (m.contains("rtf")) return "rtf";
            if (m.contains("html")) return "html";
            if (m.contains("csv")) return "csv";
            if (m.contains("text")) return "txt";
        }
        return "pdf";
    }

    private String resolveDisplayName(Uri uri) {
        String name = null;
        try {
            if ("content".equalsIgnoreCase(uri.getScheme())) {
                Cursor cursor = activity.getContentResolver().query(
                    uri,
                    new String[]{ OpenableColumns.DISPLAY_NAME },
                    null, null, null
                );
                if (cursor != null) {
                    if (cursor.moveToFirst()) {
                        int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (idx >= 0) name = cursor.getString(idx);
                    }
                    cursor.close();
                }
            }
        } catch (Exception ignored) {}
        if (name == null || name.trim().isEmpty()) {
            String seg = uri.getLastPathSegment();
            if (seg != null && !seg.trim().isEmpty()) {
                int slash = seg.lastIndexOf('/');
                name = slash >= 0 ? seg.substring(slash + 1) : seg;
            }
        }
        return sanitizeFilename(name != null ? name : "Shared_Document");
    }

    private void cleanupOldIncomingFiles(File keepFile) {
        try {
            File dir = getIncomingCacheDir();
            File[] files = dir.listFiles();
            if (files == null || files.length <= 2) return;
            Arrays.sort(files, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(b.lastModified(), a.lastModified());
                }
            });
            String keepCanon = keepFile.getCanonicalPath();
            for (int i = 2; i < files.length; i++) {
                if (!files[i].getCanonicalPath().equals(keepCanon)) {
                    files[i].delete();
                }
            }
        } catch (Exception ignored) {}
    }

    // ==================== "OPEN WITH" (WHATSAPP / TELEGRAM / FILE MANAGER) ====================
    public void handleIncomingUri(final Uri uri, final String intentMime) {
        if (uri == null) return;
        intentExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String mime = intentMime;
                    if (mime == null || mime.isEmpty() || "*/*".equals(mime)) {
                        try {
                            mime = activity.getContentResolver().getType(uri);
                        } catch (Exception ignored) {}
                    }

                    String displayName = resolveDisplayName(uri);
                    String ext = inferExtension(displayName, mime);
                    if (!displayName.toLowerCase(Locale.ROOT).endsWith("." + ext)) {
                        displayName = displayName + "." + ext;
                    }

                    // Fast direct path if file:// URI inside external storage and accessible
                    File targetFile = null;
                    if ("file".equalsIgnoreCase(uri.getScheme()) && uri.getPath() != null) {
                        File direct = validateReadableFile(uri.getPath());
                        if (direct != null) {
                            targetFile = direct;
                        }
                    }

                    // For ALL content:// URIs (WhatsApp, Telegram, Gmail, Files): stream-copy safely into app cache
                    if (targetFile == null) {
                        InputStream is = activity.getContentResolver().openInputStream(uri);
                        if (is == null) return;

                        File cacheDir = getIncomingCacheDir();
                        String tempName = System.currentTimeMillis() + "_" + sanitizeFilename(displayName);
                        File outFile = new File(cacheDir, tempName);

                        FileOutputStream fos = new FileOutputStream(outFile);
                        byte[] buf = new byte[65536];
                        int n;
                        long totalBytes = 0;
                        while ((n = is.read(buf)) != -1) {
                            fos.write(buf, 0, n);
                            totalBytes += n;
                        }
                        fos.flush();
                        fos.close();
                        is.close();

                        if (totalBytes <= 0) {
                            outFile.delete();
                            return;
                        }
                        targetFile = outFile;
                        cleanupOldIncomingFiles(outFile);
                    }

                    JSONObject obj = new JSONObject();
                    obj.put("name", displayName);
                    obj.put("path", targetFile.getCanonicalPath());
                    obj.put("folder", "Open With");
                    obj.put("size", targetFile.length());
                    obj.put("modified", targetFile.lastModified());
                    obj.put("ext", ext);
                    obj.put("fromIntent", true);

                    pendingExternalFileJson = obj.toString();

                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (activity.getBridge() != null && activity.getBridge().getWebView() != null) {
                                WebView wv = activity.getBridge().getWebView();
                                wv.evaluateJavascript(
                                    "window.__onNativeOpenExternalFile && window.__onNativeOpenExternalFile();",
                                    null
                                );
                            }
                        }
                    });
                } catch (Exception ignored) {}
            }
        });
    }

    @JavascriptInterface
    public boolean hasPendingOpenFile() {
        return pendingExternalFileJson != null && !pendingExternalFileJson.isEmpty();
    }

    @JavascriptInterface
    public synchronized String consumePendingOpenFile() {
        String out = pendingExternalFileJson;
        pendingExternalFileJson = "";
        return out != null ? out : "";
    }

    @JavascriptInterface
    public String getOwnerName() {
        try {
            SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(KEY_OWNER_NAME, "");
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean saveOwnerName(String name) {
        try {
            if (name == null) return false;
            String clean = name.trim();
            if (clean.length() < 2 || clean.length() > 40) return false;
            SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_OWNER_NAME, clean).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String getDeviceModel() {
        try {
            String m = Build.MANUFACTURER != null ? Build.MANUFACTURER : "";
            String model = Build.MODEL != null ? Build.MODEL : "Android Device";
            if (model.toLowerCase(Locale.ROOT).startsWith(m.toLowerCase(Locale.ROOT))) {
                return model;
            }
            return (m + " " + model).trim();
        } catch (Exception e) {
            return "Android Device";
        }
    }

    @JavascriptInterface
    public void setFullscreen(final boolean enable) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.applyImmersiveFullscreen(enable);
            }
        });
    }

    @JavascriptInterface
    public boolean printHtmlToPdf(final String jobTitle, final String sanitizedBodyHtml) {
        try {
            final String safeTitle = sanitizeFilename(jobTitle != null ? jobTitle : "AetherX_Document");
            final String fullDoc = "<!DOCTYPE html><html lang=\\"bn\\"><head><meta charset=\\"UTF-8\\"/>"
                + "<link rel=\\"stylesheet\\" href=\\"file:///android_asset/public/fonts/noto-sans-bengali/400.css\\"/>"
                + "<link rel=\\"stylesheet\\" href=\\"file:///android_asset/public/fonts/noto-sans-bengali/700.css\\"/>"
                + "<link rel=\\"stylesheet\\" href=\\"file:///android_asset/public/fonts/hind-siliguri/400.css\\"/>"
                + "<link rel=\\"stylesheet\\" href=\\"file:///android_asset/public/fonts/hind-siliguri/700.css\\"/>"
                + "<style>@page{size:A4;margin:14mm;}body{font-family:'Noto Sans Bengali','Hind Siliguri',sans-serif;font-size:13pt;line-height:1.72;color:#111827;margin:0;padding:0;}"
                + "img{max-width:100%;height:auto;border-radius:6px;}table{width:100%;border-collapse:collapse;margin:10px 0;}"
                + "th,td{border:1px solid #64748b;padding:6px 8px;text-align:left;}h1,h2,h3{color:#0f172a;}</style>"
                + "</head><body>" + (sanitizedBodyHtml != null ? sanitizedBodyHtml : "") + "</body></html>";

            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        WebView printWv = new WebView(activity);
                        printWv.getSettings().setJavaScriptEnabled(false);
                        printWv.getSettings().setAllowFileAccess(true);
                        printWv.setWebViewClient(new WebViewClient() {
                            @Override
                            public void onPageFinished(WebView view, String url) {
                                try {
                                    PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                                    if (pm != null) {
                                        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(safeTitle);
                                        PrintAttributes attrs = new PrintAttributes.Builder()
                                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                            .build();
                                        pm.print(safeTitle, adapter, attrs);
                                    }
                                } catch (Exception ignored) {}
                                activePrintWebView = null;
                            }
                        });
                        activePrintWebView = printWv;
                        printWv.loadDataWithBaseURL("file:///android_asset/public/", fullDoc, "text/html", "UTF-8", null);
                    } catch (Exception ignored) {}
                }
            });
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean hasStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    @JavascriptInterface
    public void requestStoragePermission() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                        intent.setData(Uri.parse("package:" + activity.getPackageName()));
                        activity.startActivity(intent);
                    } catch (Exception e) {
                        try {
                            Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                            activity.startActivity(intent);
                        } catch (Exception ignored) {}
                    }
                } else {
                    ActivityCompat.requestPermissions(
                        activity,
                        new String[]{
                            Manifest.permission.READ_EXTERNAL_STORAGE,
                            Manifest.permission.WRITE_EXTERNAL_STORAGE
                        },
                        1001
                    );
                }
            }
        });
    }

    private boolean isSupportedDoc(String lowerName) {
        return lowerName.endsWith(".pdf")
            || lowerName.endsWith(".docx")
            || lowerName.endsWith(".doc")
            || lowerName.endsWith(".txt")
            || lowerName.endsWith(".md")
            || lowerName.endsWith(".html")
            || lowerName.endsWith(".htm")
            || lowerName.endsWith(".csv")
            || lowerName.endsWith(".rtf");
    }

    @JavascriptInterface
    public void startBackgroundScan() {
        final int myGen = scanGeneration.incrementAndGet();
        scanExecutor.execute(new Runnable() {
            @Override
            public void run() {
                if (!hasStoragePermission()) {
                    lastScanJson = "[]";
                    notifyScanComplete(myGen, false);
                    return;
                }
                String json = performDocumentScan(myGen);
                if (myGen == scanGeneration.get()) {
                    lastScanJson = json;
                    notifyScanComplete(myGen, true);
                }
            }
        });
    }

    @JavascriptInterface
    public String getLastScanResult() {
        return lastScanJson != null ? lastScanJson : "[]";
    }

    private void notifyScanComplete(final int gen, final boolean permitted) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (gen != scanGeneration.get()) return;
                if (activity.getBridge() != null && activity.getBridge().getWebView() != null) {
                    WebView wv = activity.getBridge().getWebView();
                    wv.evaluateJavascript(
                        "window.__onNativeScanComplete && window.__onNativeScanComplete(" + gen + "," + (permitted ? "true" : "false") + ");",
                        null
                    );
                }
            }
        });
    }

    private String performDocumentScan(int myGen) {
        List<File> found = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        try {
            File root = Environment.getExternalStorageDirectory();
            if (root != null && root.exists() && root.canRead()) {
                scanDirRecursive(root, found, seen, 0, myGen);
            }
        } catch (Exception ignored) {}

        if (myGen != scanGeneration.get()) return "[]";

        try {
            Uri uri = MediaStore.Files.getContentUri("external");
            String[] projection = new String[]{ MediaStore.Files.FileColumns.DATA };
            String selection = MediaStore.Files.FileColumns.DATA + " LIKE '%.pdf' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.docx' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.doc' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.txt' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.md' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.html' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.htm' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.csv' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.rtf'";
            Cursor cursor = activity.getContentResolver().query(uri, projection, selection, null, null);
            if (cursor != null) {
                int dataIdx = cursor.getColumnIndex(MediaStore.Files.FileColumns.DATA);
                while (cursor.moveToNext() && found.size() < 2000) {
                    if (myGen != scanGeneration.get()) break;
                    if (dataIdx >= 0) {
                        String p = cursor.getString(dataIdx);
                        if (p != null && !seen.contains(p)) {
                            File f = new File(p);
                            if (f.exists() && f.isFile() && f.length() > 0 && f.canRead()) {
                                seen.add(p);
                                found.add(f);
                            }
                        }
                    }
                }
                cursor.close();
            }
        } catch (Exception ignored) {}

        Collections.sort(found, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.compare(b.lastModified(), a.lastModified());
            }
        });

        JSONArray arr = new JSONArray();
        for (int i = 0; i < found.size(); i++) {
            File f = found.get(i);
            try {
                JSONObject obj = new JSONObject();
                String name = f.getName();
                int dot = name.lastIndexOf('.');
                String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
                File parent = f.getParentFile();
                obj.put("name", name);
                obj.put("path", f.getAbsolutePath());
                obj.put("folder", parent != null ? parent.getName() : "Storage");
                obj.put("size", f.length());
                obj.put("modified", f.lastModified());
                obj.put("ext", ext);
                arr.put(obj);
            } catch (Exception ignored) {}
        }
        return arr.toString();
    }

    private void scanDirRecursive(File dir, List<File> out, Set<String> seen, int depth, int myGen) {
        if (depth > 5 || out.size() >= 2000 || myGen != scanGeneration.get()) return;
        String dirName = dir.getName();
        String lowerDir = dirName.toLowerCase(Locale.ROOT);
        if (depth > 0) {
            if (dirName.startsWith(".") || SKIP_DIRS.contains(lowerDir)) return;
            if (lowerDir.equals("android")) {
                File waMedia = new File(dir, "media");
                if (waMedia.exists() && waMedia.isDirectory()) {
                    scanDirRecursive(waMedia, out, seen, depth + 1, myGen);
                }
                return;
            }
        }
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (out.size() >= 2000 || myGen != scanGeneration.get()) break;
            if (child.isDirectory()) {
                scanDirRecursive(child, out, seen, depth + 1, myGen);
            } else if (child.isFile() && child.length() > 0) {
                String lower = child.getName().toLowerCase(Locale.ROOT);
                if (isSupportedDoc(lower)) {
                    String abs = child.getAbsolutePath();
                    if (!seen.contains(abs)) {
                        seen.add(abs);
                        out.add(child);
                    }
                }
            }
        }
    }

    @JavascriptInterface
    public String openPdfSession(String filePath) {
        JSONObject res = new JSONObject();
        try {
            File f = validateReadableFile(filePath);
            if (f == null || !f.getName().toLowerCase(Locale.ROOT).endsWith(".pdf")) {
                res.put("ok", false);
                res.put("error", hasStoragePermission() ? "Invalid or inaccessible PDF path" : "Storage permission required");
                return res.toString();
            }
            closeAllPdfSessions();

            RandomAccessFile raf = new RandomAccessFile(f, "r");
            long len = raf.length();
            if (len <= 0) {
                raf.close();
                res.put("ok", false);
                res.put("error", "Empty PDF file");
                return res.toString();
            }
            int headLen = (int) Math.min(512, len);
            byte[] headBuf = new byte[headLen];
            raf.seek(0);
            raf.readFully(headBuf);
            String headHash = Integer.toHexString(Arrays.hashCode(headBuf));

            String sid = UUID.randomUUID().toString();
            pdfSessions.put(sid, raf);
            res.put("ok", true);
            res.put("sessionId", sid);
            res.put("length", len);
            res.put("size", len);
            res.put("modified", f.lastModified());
            res.put("headHash", headHash);
            return res.toString();
        } catch (Exception e) {
            try {
                res.put("ok", false);
                res.put("error", e.getMessage() != null ? e.getMessage() : "Open failed");
            } catch (Exception ignored) {}
            return res.toString();
        }
    }

    @JavascriptInterface
    public String readPdfChunk(String sessionId, double beginD, double endD) {
        try {
            if (sessionId == null || !pdfSessions.containsKey(sessionId)) return "";
            RandomAccessFile raf = pdfSessions.get(sessionId);
            if (raf == null) return "";
            long begin = (long) Math.max(0, beginD);
            long end = (long) Math.max(begin, endD);
            synchronized (raf) {
                long fileLen = raf.length();
                if (begin < 0 || begin >= fileLen) return "";
                long clampedEnd = Math.min(end, fileLen);
                int toRead = (int) Math.min(clampedEnd - begin, 1024 * 1024);
                if (toRead <= 0) return "";
                byte[] buf = new byte[toRead];
                raf.seek(begin);
                int total = 0;
                while (total < toRead) {
                    int n = raf.read(buf, total, toRead - total);
                    if (n < 0) break;
                    total += n;
                }
                if (total <= 0) return "";
                return Base64.encodeToString(buf, 0, total, Base64.NO_WRAP);
            }
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public void closePdfSession(String sessionId) {
        if (sessionId == null) return;
        RandomAccessFile raf = pdfSessions.remove(sessionId);
        if (raf != null) {
            try { raf.close(); } catch (Exception ignored) {}
        }
    }

    @JavascriptInterface
    public void closeAllPdfSessions() {
        for (Map.Entry<String, RandomAccessFile> entry : pdfSessions.entrySet()) {
            try { entry.getValue().close(); } catch (Exception ignored) {}
        }
        pdfSessions.clear();
    }

    @JavascriptInterface
    public String readSmallDocBase64(String filePath) {
        try {
            File file = validateReadableFile(filePath);
            if (file == null || file.length() > 55 * 1024 * 1024) return "";
            String lower = file.getName().toLowerCase(Locale.ROOT);
            if (!isSupportedDoc(lower)) return "";
            FileInputStream fis = new FileInputStream(file);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int read;
            while ((read = fis.read(buf)) != -1) {
                bos.write(buf, 0, read);
            }
            fis.close();
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public String saveBase64ToDocuments(String filename, String base64Data) {
        JSONObject res = new JSONObject();
        try {
            if (base64Data == null || base64Data.isEmpty()) {
                res.put("ok", false);
                res.put("error", "Empty file data");
                return res.toString();
            }
            String safeName = sanitizeFilename(filename);
            File docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            File folder = new File(docs, "AetherX_PDF");
            if (!folder.exists() && !folder.mkdirs()) {
                res.put("ok", false);
                res.put("error", "Cannot create Documents/AetherX_PDF folder");
                return res.toString();
            }
            File outFile = new File(folder, safeName);
            String folderCanon = folder.getCanonicalPath();
            String outCanon = outFile.getCanonicalPath();
            if (!outCanon.startsWith(folderCanon + File.separator)) {
                res.put("ok", false);
                res.put("error", "Invalid output path");
                return res.toString();
            }
            byte[] data = Base64.decode(base64Data, Base64.DEFAULT);
            FileOutputStream fos = new FileOutputStream(outFile);
            fos.write(data);
            fos.flush();
            fos.close();

            if (!outFile.exists() || outFile.length() != data.length) {
                res.put("ok", false);
                res.put("error", "Write verification failed");
                return res.toString();
            }
            res.put("ok", true);
            res.put("path", outCanon);
            res.put("name", safeName);
            res.put("bytes", outFile.length());
            return res.toString();
        } catch (Exception e) {
            try {
                res.put("ok", false);
                res.put("error", e.getMessage() != null ? e.getMessage() : "Save failed");
            } catch (Exception ignored) {}
            return res.toString();
        }
    }
}
`;
  fs.writeFileSync(path.join(pkgPath, 'NativeStorageBridge.java'), nativeBridgeJava, 'utf8');

  // 2. MainActivity.java (Captures ACTION_VIEW on BOTH Cold Start onCreate & Warm Start onNewIntent!)
  const mainActivityJava = `package com.aetherx.pdfreader;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean immersiveActive = false;
    private NativeStorageBridge storageBridge;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Window window = getWindow();
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            window.setStatusBarColor(Color.parseColor("#050812"));
            window.setNavigationBarColor(Color.parseColor("#050812"));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }
        } catch (Exception ignored) {}

        if (this.getBridge() != null && this.getBridge().getWebView() != null) {
            WebView webView = this.getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#050812"));
            storageBridge = new NativeStorageBridge(this);
            webView.addJavascriptInterface(storageBridge, "GlassNative");
            WebSettings settings = webView.getSettings();
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(true);
            settings.setDomStorageEnabled(true);
        }

        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null || storageBridge == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data != null) {
                storageBridge.handleIncomingUri(data, intent.getType());
            }
        }
    }

    @Override
    public void onDestroy() {
        if (storageBridge != null) {
            storageBridge.cleanup();
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersiveActive) {
            applyImmersiveFullscreen(true);
        }
    }

    public void applyImmersiveFullscreen(boolean enable) {
        immersiveActive = enable;
        try {
            Window window = getWindow();
            View decorView = window.getDecorView();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decorView);
            if (enable) {
                WindowCompat.setDecorFitsSystemWindows(window, false);
                if (controller != null) {
                    controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    );
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                }
                decorView.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                );
            } else {
                WindowCompat.setDecorFitsSystemWindows(window, true);
                if (controller != null) {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
                decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
        } catch (Exception ignored) {}
    }
}
`;
  fs.writeFileSync(path.join(pkgPath, 'MainActivity.java'), mainActivityJava, 'utf8');

  // 3. Patch AndroidManifest.xml with ACTION_VIEW "Open With" Intent Filters!
  const manifestPath = 'android/app/src/main/AndroidManifest.xml';
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  if (!manifest.includes('xmlns:tools=')) {
    manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
  }
  const permsBlock = `
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
`;
  if (!manifest.includes('MANAGE_EXTERNAL_STORAGE')) {
    manifest = manifest.replace('<application', permsBlock + '\n    <application');
  }
  if (!manifest.includes('requestLegacyExternalStorage')) {
    manifest = manifest.replace('<application', '<application android:requestLegacyExternalStorage="true"');
  }
  if (!manifest.includes('windowSoftInputMode')) {
    manifest = manifest.replace('<activity', '<activity android:windowSoftInputMode="adjustResize"');
  }

  // Inject ACTION_VIEW intent-filters for PDF, DOCX, RTF, TXT, HTML (WhatsApp, Telegram, Gmail, File Managers)
  const viewIntentFilters = `
            <!-- Open With: PDF from WhatsApp, Telegram, Gmail, File Managers -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="application/pdf" />
            </intent-filter>

            <!-- Open With: DOCX, RTF, TXT, HTML Documents -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
                <data android:mimeType="application/rtf" />
                <data android:mimeType="text/rtf" />
                <data android:mimeType="text/plain" />
                <data android:mimeType="text/html" />
            </intent-filter>

            <!-- Fallback for file managers sending generic MIME type for .pdf -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="file" android:host="*" android:mimeType="*/*" android:pathPattern=".*\\.pdf" />
                <data android:scheme="file" android:host="*" android:mimeType="*/*" android:pathPattern=".*\\.PDF" />
            </intent-filter>`;

  if (!manifest.includes('android.intent.action.VIEW')) {
    manifest = manifest.replace(
      /(<category\s+android:name="android\.intent\.category\.LAUNCHER"\s*\/>\s*<\/intent-filter>)/,
      '$1\n' + viewIntentFilters
    );
    if (!manifest.includes('android.intent.action.VIEW')) {
      manifest = manifest.replace('</activity>', viewIntentFilters + '\n        </activity>');
    }
    console.log('Added ACTION_VIEW (Open With) intent-filters to AndroidManifest.xml!');
  }
  fs.writeFileSync(manifestPath, manifest, 'utf8');

  // 4. Custom AetherX Dark Splash Themes (No Capacitor Default Logo)
  const bgColorXmlPath = 'android/app/src/main/res/values/ic_launcher_background.xml';
  fs.mkdirSync(path.dirname(bgColorXmlPath), { recursive: true });
  fs.writeFileSync(
    bgColorXmlPath,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#050812</color>\n    <color name="aetherx_splash_bg">#050812</color>\n</resources>\n',
    'utf8'
  );

  const stylesXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
        <item name="android:windowBackground">@color/aetherx_splash_bg</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@color/aetherx_splash_bg</item>
        <item name="android:windowBackground">@color/aetherx_splash_bg</item>
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@color/aetherx_splash_bg</item>
        <item name="android:windowBackground">@color/aetherx_splash_bg</item>
        <item name="windowSplashScreenBackground">@color/aetherx_splash_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
`;
  fs.writeFileSync('android/app/src/main/res/values/styles.xml', stylesXml, 'utf8');

  const v31Dir = 'android/app/src/main/res/values-v31';
  fs.mkdirSync(v31Dir, { recursive: true });
  const stylesV31Xml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:windowSplashScreenBackground">@color/aetherx_splash_bg</item>
        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="windowSplashScreenBackground">@color/aetherx_splash_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
`;
  fs.writeFileSync(path.join(v31Dir, 'styles.xml'), stylesV31Xml, 'utf8');

  // 5. Bump versionCode=33, versionName="3.2.1" & Env Signing
  const gradlePath = 'android/app/build.gradle';
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode 33');
  gradle = gradle.replace(/versionName\s+"[^"]+"/, 'versionName "3.2.1"');

  if (!gradle.includes('System.getenv("KEYSTORE_PASS")')) {
    gradle = gradle.replace(
      /buildTypes\s*\{\s*release\s*\{/,
      'buildTypes {\n        release {\n            signingConfig signingConfigs.release'
    );
    const signingBlock = `
    signingConfigs {
        release {
            def ksPath = System.getenv("KEYSTORE_PATH")
            if (ksPath != null && file(ksPath).exists()) {
                storeFile file(ksPath)
                storePassword System.getenv("KEYSTORE_PASS")
                keyAlias System.getenv("KEY_ALIAS")
                keyPassword System.getenv("KEY_PASS")
            }
        }
    }
    lint {
        checkReleaseBuilds false
        abortOnError false
    }
    buildTypes {`;
    gradle = gradle.replace('buildTypes {', signingBlock);
  }
  fs.writeFileSync(gradlePath, gradle, 'utf8');
  console.log('Patched Android v3.2.1 with Open With (ACTION_VIEW), Print-to-PDF, custom splash & env signing!');
}

if (process.argv.includes('--patch-android')) {
  patchAndroidNative();
} else {
  prepareWebAssets();
}
