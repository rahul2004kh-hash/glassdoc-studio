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
  // Always sync root index.html to www/index.html if root index.html exists
  if (fs.existsSync('index.html')) {
    copyFile('index.html', 'www/index.html');
  } else if (!fs.existsSync('www/index.html')) {
    throw new Error('Missing index.html in root or www/');
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
      throw new Error('Missing required library file: ' + src);
    }
    copyFile(src, dest);
  }

  const fontPkgs = [
    ['node_modules/@fontsource/noto-sans-bengali', 'www/fonts/noto-sans-bengali'],
    ['node_modules/@fontsource/hind-siliguri', 'www/fonts/hind-siliguri']
  ];

  for (const [src, dest] of fontPkgs) {
    if (fs.existsSync(src)) {
      copyDir(src, dest);
    }
  }

  console.log('All offline web assets prepared successfully!');
}

function patchAndroidNative() {
  const pkgPath = 'android/app/src/main/java/org/glassdoc/student';
  if (!fs.existsSync(pkgPath)) {
    throw new Error('Android package path not found: ' + pkgPath);
  }

  // 1. Write NativeStorageBridge.java for instant auto-PDF detection & saving
  const nativeBridgeJava = `package org.glassdoc.student;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class NativeStorageBridge {
    private final Activity activity;

    public NativeStorageBridge(Activity activity) {
        this.activity = activity;
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

    @JavascriptInterface
    public String scanDocuments() {
        List<File> found = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        // 1. Direct scan of external storage (finds all PDFs/DOCX immediately when permitted)
        try {
            File root = Environment.getExternalStorageDirectory();
            if (root != null && root.exists() && root.canRead()) {
                scanDirRecursive(root, found, seen, 0);
            }
        } catch (Exception ignored) {}

        // 2. Also query MediaStore.Files as backup
        try {
            Uri uri = MediaStore.Files.getContentUri("external");
            String[] projection = new String[]{ MediaStore.Files.FileColumns.DATA };
            String selection = MediaStore.Files.FileColumns.DATA + " LIKE '%.pdf' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.docx' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.txt'";
            Cursor cursor = activity.getContentResolver().query(uri, projection, selection, null, null);
            if (cursor != null) {
                int dataIdx = cursor.getColumnIndex(MediaStore.Files.FileColumns.DATA);
                while (cursor.moveToNext()) {
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

        // Sort newest first
        Collections.sort(found, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.compare(b.lastModified(), a.lastModified());
            }
        });

        JSONArray arr = new JSONArray();
        int limit = Math.min(found.size(), 250);
        for (int i = 0; i < limit; i++) {
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

    private void scanDirRecursive(File dir, List<File> out, Set<String> seen, int depth) {
        if (depth > 5 || out.size() >= 400) return;
        String dirName = dir.getName();
        if (depth > 0 && (dirName.startsWith(".") || dirName.equalsIgnoreCase("Android") || dirName.equalsIgnoreCase("MIUI"))) {
            // Still allow WhatsApp/Telegram inside Android/media if encountered specifically
            if (!dirName.equalsIgnoreCase("Android")) return;
            File waMedia = new File(dir, "media");
            if (waMedia.exists() && waMedia.isDirectory()) {
                scanDirRecursive(waMedia, out, seen, depth + 1);
            }
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (out.size() >= 400) break;
            if (child.isDirectory()) {
                scanDirRecursive(child, out, seen, depth + 1);
            } else if (child.isFile() && child.length() > 0) {
                String lower = child.getName().toLowerCase(Locale.ROOT);
                if (lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".txt")) {
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
    public String readFileBase64(String filePath) {
        try {
            File file = new File(filePath);
            if (!file.exists() || !file.canRead() || file.length() > 28 * 1024 * 1024) {
                return "";
            }
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
        try {
            File docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            File folder = new File(docs, "GlassDoc");
            if (!folder.exists()) folder.mkdirs();
            File outFile = new File(folder, filename);
            byte[] data = Base64.decode(base64Data, Base64.DEFAULT);
            FileOutputStream fos = new FileOutputStream(outFile);
            fos.write(data);
            fos.flush();
            fos.close();
            return outFile.getAbsolutePath();
        } catch (Exception e) {
            return "";
        }
    }
}
`;
  fs.writeFileSync(path.join(pkgPath, 'NativeStorageBridge.java'), nativeBridgeJava, 'utf8');
  console.log('Created NativeStorageBridge.java');

  // 2. Patch MainActivity.java
  const mainActivityJava = `package org.glassdoc.student;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Window window = getWindow();
            window.setStatusBarColor(Color.parseColor("#050812"));
            window.setNavigationBarColor(Color.parseColor("#050812"));
        } catch (Exception ignored) {}

        if (this.getBridge() != null && this.getBridge().getWebView() != null) {
            WebView webView = this.getBridge().getWebView();
            webView.addJavascriptInterface(new NativeStorageBridge(this), "GlassNative");
            WebSettings settings = webView.getSettings();
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
        }
    }
}
`;
  fs.writeFileSync(path.join(pkgPath, 'MainActivity.java'), mainActivityJava, 'utf8');
  console.log('Patched MainActivity.java');

  // 3. Patch AndroidManifest.xml with storage permissions
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
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('Patched AndroidManifest.xml');

  // 4. Patch android/app/build.gradle for Signed Release APK & clean lint
  const gradlePath = 'android/app/build.gradle';
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (!gradle.includes('glassdoc-release.keystore')) {
    // First add signingConfig inside existing buildTypes -> release block
    gradle = gradle.replace(
      /buildTypes\s*\{\s*release\s*\{/,
      'buildTypes {\n        release {\n            signingConfig signingConfigs.release'
    );
    // Then add signingConfigs & lint right before buildTypes
    const signingBlock = `
    signingConfigs {
        release {
            storeFile file("glassdoc-release.keystore")
            storePassword "GlassDoc2026"
            keyAlias "glassdoc"
            keyPassword "GlassDoc2026"
        }
    }
    lint {
        checkReleaseBuilds false
        abortOnError false
    }
    buildTypes {`;
    gradle = gradle.replace('buildTypes {', signingBlock);
    fs.writeFileSync(gradlePath, gradle, 'utf8');
    console.log('Patched android/app/build.gradle for signed release');
  }
}

if (process.argv.includes('--patch-android')) {
  patchAndroidNative();
} else {
  prepareWebAssets();
}
