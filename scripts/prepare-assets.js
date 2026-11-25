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
  const pkgPath = 'android/app/src/main/java/com/aetherx/pdfreader';
  if (!fs.existsSync(pkgPath)) {
    throw new Error('Android package path not found: ' + pkgPath);
  }

  // 1. NativeStorageBridge.java (Owner Prefs + Fullscreen + All-Document Scanner + Save)
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
    private final MainActivity activity;
    private static final String PREFS_NAME = "AetherXOwnerPrefs";
    private static final String KEY_OWNER_NAME = "owner_name";

    public NativeStorageBridge(MainActivity activity) {
        this.activity = activity;
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
    public void saveOwnerName(String name) {
        try {
            SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_OWNER_NAME, name != null ? name.trim() : "").apply();
        } catch (Exception ignored) {}
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
    public String scanDocuments() {
        if (!hasStoragePermission()) {
            return "[]";
        }
        List<File> found = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        try {
            File root = Environment.getExternalStorageDirectory();
            if (root != null && root.exists() && root.canRead()) {
                scanDirRecursive(root, found, seen, 0);
            }
        } catch (Exception ignored) {}

        try {
            Uri uri = MediaStore.Files.getContentUri("external");
            String[] projection = new String[]{ MediaStore.Files.FileColumns.DATA };
            String selection = MediaStore.Files.FileColumns.DATA + " LIKE '%.pdf' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.docx' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.doc' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.txt' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.md' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.html' OR "
                    + MediaStore.Files.FileColumns.DATA + " LIKE '%.csv'";
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

        Collections.sort(found, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.compare(b.lastModified(), a.lastModified());
            }
        });

        JSONArray arr = new JSONArray();
        int limit = Math.min(found.size(), 350);
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
        if (depth > 5 || out.size() >= 500) return;
        String dirName = dir.getName();
        if (depth > 0 && (dirName.startsWith(".") || dirName.equalsIgnoreCase("Android") || dirName.equalsIgnoreCase("MIUI"))) {
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
            if (out.size() >= 500) break;
            if (child.isDirectory()) {
                scanDirRecursive(child, out, seen, depth + 1);
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
    public String readFileBase64(String filePath) {
        try {
            File file = new File(filePath);
            if (!file.exists() || !file.canRead() || file.length() > 40 * 1024 * 1024) {
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
            File folder = new File(docs, "AetherX_PDF");
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

  // 2. MainActivity.java (Immersive Fullscreen + AdjustResize + Hardware Acceleration)
  const mainActivityJava = `package com.aetherx.pdfreader;

import android.graphics.Color;
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
            webView.addJavascriptInterface(new NativeStorageBridge(this), "GlassNative");
            WebSettings settings = webView.getSettings();
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setDomStorageEnabled(true);
        }
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
  console.log('Patched MainActivity.java');

  // 3. Patch AndroidManifest.xml (Storage permissions + adjustResize + tablet resizeable)
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
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('Patched AndroidManifest.xml');

  // 4. Patch Adaptive Icon Background color (#050812) so custom icon blends seamlessly
  const bgColorXmlPath = 'android/app/src/main/res/values/ic_launcher_background.xml';
  fs.mkdirSync(path.dirname(bgColorXmlPath), { recursive: true });
  fs.writeFileSync(
    bgColorXmlPath,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#050812</color>\n</resources>\n',
    'utf8'
  );
  console.log('Patched ic_launcher_background.xml');

  // 5. Patch android/app/build.gradle for Signed Release APK
  const gradlePath = 'android/app/build.gradle';
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (!gradle.includes('aetherx-release.keystore')) {
    gradle = gradle.replace(
      /buildTypes\s*\{\s*release\s*\{/,
      'buildTypes {\n        release {\n            signingConfig signingConfigs.release'
    );
    const signingBlock = `
    signingConfigs {
        release {
            storeFile file("aetherx-release.keystore")
            storePassword "AetherX2026"
            keyAlias "aetherx"
            keyPassword "AetherX2026"
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
