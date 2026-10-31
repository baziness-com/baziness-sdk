// Based on UnityWebViewPostprocessBuild.cs of gree/unity-webview (https://github.com/gree/unity-webview),
// zlib licence: see "Third Party Notices.md". ALTERED for the Baziness SDK: renamed and put in a namespace;
// the Android plugin is a regular library of this package, so nothing is copied into Assets at build time;
// Unity 2021.3 or newer only (the pre-2018 code paths are removed).
#if UNITY_EDITOR
using System.Collections.Generic;
using System.Collections;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Text;
using System.Xml;
using System;
using UnityEditor.Android;
using UnityEditor.Callbacks;
using UnityEditor;
using UnityEngine;

namespace Baziness.Editor
{
/// <summary>Adjusts the Android project (manifest, AndroidX) and the Xcode project (WebKit) for the bundled web view.</summary>
internal sealed class WebViewBuildProcessor : IPostGenerateGradleAndroidProject
{
    private static bool nofragment = false;

    //// for android/unity 2018.1 or newer
    //// cf. https://forum.unity.com/threads/android-hardwareaccelerated-is-forced-false-in-all-activities.532786/
    //// cf. https://github.com/Over17/UnityAndroidManifestCallback

    public void OnPostGenerateGradleAndroidProject(string basePath) {
        var changed = false;
        var androidManifest = new AndroidManifest(GetManifestPath(basePath));
        if (!nofragment) {
            changed = (androidManifest.AddFileProvider(basePath) || changed);
            {
                var path = GetBuildGradlePath(basePath);
                var lines0 = File.ReadAllText(path).Replace("\r\n", "\n").Replace("\r", "\n").Split(new[]{'\n'});
                {
                    var lines = new List<string>();
                    var independencies = false;
                    foreach (var line in lines0) {
                        if (line == "dependencies {") {
                            independencies = true;
                        } else if (independencies && line == "}") {
                            independencies = false;
                            lines.Add("    implementation 'androidx.core:core:1.6.0'");
                        } else if (independencies) {
                            if (line.Contains("implementation(name: 'core")
                                || line.Contains("implementation(name: 'androidx.core.core")
                                || line.Contains("implementation 'androidx.core:core")) {
                                break;
                            }
                        }
                        lines.Add(line);
                    }
                    if (lines.Count > lines0.Length) {
                        File.WriteAllText(path, string.Join("\n", lines) + "\n");
                    }
                }
            }
            {
                var path = GetGradlePropertiesPath(basePath);
                var lines0 = "";
                var lines = "";
                if (File.Exists(path)) {
                    lines0 = File.ReadAllText(path).Replace("\r\n", "\n").Replace("\r", "\n") + "\n";
                    lines = lines0;
                }
                if (!lines.Contains("android.useAndroidX=true")) {
                    lines += "android.useAndroidX=true\n";
                }
                if (!lines.Contains("android.enableJetifier=true")) {
                    lines += "android.enableJetifier=true\n";
                }
                if (lines != lines0) {
                    File.WriteAllText(path, lines);
                }
            }
        }
        changed = (androidManifest.SetExported(true) || changed);
        changed = (androidManifest.SetWindowSoftInputMode("adjustPan") || changed);
        changed = (androidManifest.SetHardwareAccelerated(true) || changed);
#if UNITYWEBVIEW_ANDROID_USES_CLEARTEXT_TRAFFIC
        changed = (androidManifest.SetUsesCleartextTraffic(true) || changed);
#endif
#if UNITYWEBVIEW_ANDROID_ENABLE_CAMERA
        changed = (androidManifest.AddCamera() || changed);
        changed = (androidManifest.AddGallery() || changed);
#endif
#if UNITYWEBVIEW_ANDROID_ENABLE_MICROPHONE
        changed = (androidManifest.AddMicrophone() || changed);
#endif
        if (changed) {
            androidManifest.Save();
            Debug.Log("unitywebview: adjusted AndroidManifest.xml.");
        }
    }

    public int callbackOrder {
        get {
            return 1;
        }
    }

    private string GetManifestPath(string basePath) {
        var pathBuilder = new StringBuilder(basePath);
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("src");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("main");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("AndroidManifest.xml");
        return pathBuilder.ToString();
    }

    private string GetBuildGradlePath(string basePath) {
        var pathBuilder = new StringBuilder(basePath);
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("build.gradle");
        return pathBuilder.ToString();
    }

    private string GetGradlePropertiesPath(string basePath) {
        var pathBuilder = new StringBuilder(basePath);
        if (basePath.EndsWith("unityLibrary")) {
            pathBuilder.Append(Path.DirectorySeparatorChar).Append("..");
        }
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("gradle.properties");
        return pathBuilder.ToString();
    }

    //// for others

    [PostProcessBuild(100)]
    public static void OnPostprocessBuild(BuildTarget buildTarget, string path) {
        if (buildTarget == BuildTarget.iOS) {
            string projPath = path + "/Unity-iPhone.xcodeproj/project.pbxproj";
            var type = Type.GetType("UnityEditor.iOS.Xcode.PBXProject, UnityEditor.iOS.Extensions.Xcode");
            if (type == null)
            {
                Debug.LogError("unitywebview: failed to get PBXProject. please install iOS build support.");
                return;
            }
            var src = File.ReadAllText(projPath);
            //dynamic proj = type.GetConstructor(Type.EmptyTypes).Invoke(null);
            var proj = type.GetConstructor(Type.EmptyTypes).Invoke(null);
            //proj.ReadFromString(src);
            {
                var method = type.GetMethod("ReadFromString");
                method.Invoke(proj, new object[]{src});
            }
            var target = "";
#if UNITY_2019_3_OR_NEWER
            //target = proj.GetUnityFrameworkTargetGuid();
            {
                var method = type.GetMethod("GetUnityFrameworkTargetGuid");
                target = (string)method.Invoke(proj, null);
            }
#else
            //target = proj.TargetGuidByName("Unity-iPhone");
            {
                var method = type.GetMethod("TargetGuidByName");
                target = (string)method.Invoke(proj, new object[]{"Unity-iPhone"});
            }
#endif
            //proj.AddFrameworkToProject(target, "WebKit.framework", false);
            {
                var method = type.GetMethod("AddFrameworkToProject");
                method.Invoke(proj, new object[]{target, "WebKit.framework", false});
            }
            var cflags = "";
            if (EditorUserBuildSettings.development) {
                cflags += " -DUNITYWEBVIEW_DEVELOPMENT";
            }
#if UNITYWEBVIEW_IOS_ALLOW_FILE_URLS
            cflags += " -DUNITYWEBVIEW_IOS_ALLOW_FILE_URLS";
#endif
            cflags = cflags.Trim();
            if (!string.IsNullOrEmpty(cflags)) {
                // proj.AddBuildProperty(target, "OTHER_LDFLAGS", cflags);
                var method = type.GetMethod("AddBuildProperty", new Type[]{typeof(string), typeof(string), typeof(string)});
                method.Invoke(proj, new object[]{target, "OTHER_CFLAGS", cflags});
            }
            var dst = "";
            //dst = proj.WriteToString();
            {
                var method = type.GetMethod("WriteToString");
                dst = (string)method.Invoke(proj, null);
            }
            File.WriteAllText(projPath, dst);
        }
    }
}

internal class AndroidXmlDocument : XmlDocument {
    private string m_Path;
    protected XmlNamespaceManager nsMgr;
    public readonly string AndroidXmlNamespace = "http://schemas.android.com/apk/res/android";

    public AndroidXmlDocument(string path) {
        m_Path = path;
        using (var reader = new XmlTextReader(m_Path)) {
            reader.Read();
            Load(reader);
        }
        nsMgr = new XmlNamespaceManager(NameTable);
        nsMgr.AddNamespace("android", AndroidXmlNamespace);
    }

    public string Save() {
        return SaveAs(m_Path);
    }

    public string SaveAs(string path) {
        using (var writer = new XmlTextWriter(path, new UTF8Encoding(false))) {
            writer.Formatting = Formatting.Indented;
            Save(writer);
        }
        return path;
    }
}

internal class AndroidManifest : AndroidXmlDocument {
    private readonly XmlElement ManifestElement;
    private readonly XmlElement ApplicationElement;

    public AndroidManifest(string path) : base(path) {
        ManifestElement = SelectSingleNode("/manifest") as XmlElement;
        ApplicationElement = SelectSingleNode("/manifest/application") as XmlElement;
    }

    private XmlAttribute CreateAndroidAttribute(string key, string value) {
        XmlAttribute attr = CreateAttribute("android", key, AndroidXmlNamespace);
        attr.Value = value;
        return attr;
    }

    internal XmlNode GetActivityWithLaunchIntent() {
        return
            SelectSingleNode(
                "/manifest/application/activity[intent-filter/action/@android:name='android.intent.action.MAIN' and "
                + "intent-filter/category/@android:name='android.intent.category.LAUNCHER']",
                nsMgr);
    }

    internal bool SetUsesCleartextTraffic(bool enabled) {
        // android:usesCleartextTraffic
        bool changed = false;
        if (ApplicationElement.GetAttribute("usesCleartextTraffic", AndroidXmlNamespace) != ((enabled) ? "true" : "false")) {
            ApplicationElement.SetAttribute("usesCleartextTraffic", AndroidXmlNamespace, (enabled) ? "true" : "false");
            changed = true;
        }
        return changed;
    }

    // for api level 33
    internal bool SetExported(bool enabled) {
        bool changed = false;
        var activity = GetActivityWithLaunchIntent() as XmlElement;
        if (activity.GetAttribute("exported", AndroidXmlNamespace) != ((enabled) ? "true" : "false")) {
            activity.SetAttribute("exported", AndroidXmlNamespace, (enabled) ? "true" : "false");
            changed = true;
        }
        return changed;
    }

    internal bool SetWindowSoftInputMode(string mode) {
        bool changed = false;
        var activity = GetActivityWithLaunchIntent() as XmlElement;
        if (activity.GetAttribute("windowSoftInputMode", AndroidXmlNamespace) != mode) {
            activity.SetAttribute("windowSoftInputMode", AndroidXmlNamespace, mode);
            changed = true;
        }
        return changed;
    }

    internal bool SetHardwareAccelerated(bool enabled) {
        bool changed = false;
        var activity = GetActivityWithLaunchIntent() as XmlElement;
        if (activity.GetAttribute("hardwareAccelerated", AndroidXmlNamespace) != ((enabled) ? "true" : "false")) {
            activity.SetAttribute("hardwareAccelerated", AndroidXmlNamespace, (enabled) ? "true" : "false");
            changed = true;
        }
        return changed;
    }

    internal bool SetActivityName(string name) {
        bool changed = false;
        var activity = GetActivityWithLaunchIntent() as XmlElement;
        if (activity.GetAttribute("name", AndroidXmlNamespace) != name) {
            activity.SetAttribute("name", AndroidXmlNamespace, name);
            changed = true;
        }
        return changed;
    }

    internal bool AddFileProvider(string basePath) {
        bool changed = false;
        var authorities = PlayerSettings.applicationIdentifier + ".unitywebview.fileprovider";
        if (SelectNodes("/manifest/application/provider[@android:authorities='" + authorities + "']", nsMgr).Count == 0) {
            var elem = CreateElement("provider");
            elem.Attributes.Append(CreateAndroidAttribute("name", "androidx.core.content.FileProvider"));
            elem.Attributes.Append(CreateAndroidAttribute("authorities", authorities));
            elem.Attributes.Append(CreateAndroidAttribute("exported", "false"));
            elem.Attributes.Append(CreateAndroidAttribute("grantUriPermissions", "true"));
            var meta = CreateElement("meta-data");
            meta.Attributes.Append(CreateAndroidAttribute("name", "android.support.FILE_PROVIDER_PATHS"));
            meta.Attributes.Append(CreateAndroidAttribute("resource", "@xml/unitywebview_file_provider_paths"));
            elem.AppendChild(meta);
            ApplicationElement.AppendChild(elem);
            changed = true;
            var xml = GetFileProviderSettingPath(basePath);
            if (!File.Exists(xml)) {
                Directory.CreateDirectory(Path.GetDirectoryName(xml));
                File.WriteAllText(
                    xml,
                    "<paths xmlns:android=\"http://schemas.android.com/apk/res/android\">\n" +
                    "  <external-path name=\"unitywebview_file_provider_images\" path=\".\"/>\n" +
                    "</paths>\n");
            }
        }
        return changed;
    }

    private string GetFileProviderSettingPath(string basePath) {
        var pathBuilder = new StringBuilder(basePath);
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("src");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("main");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("res");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("xml");
        pathBuilder.Append(Path.DirectorySeparatorChar).Append("unitywebview_file_provider_paths.xml");
        return pathBuilder.ToString();
    }

    internal bool AddCamera() {
        bool changed = false;
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.CAMERA']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.CAMERA"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/uses-feature[@android:name='android.hardware.camera']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-feature");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.hardware.camera"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        // cf. https://developer.android.com/training/data-storage/shared/media#media-location-permission
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.ACCESS_MEDIA_LOCATION']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.ACCESS_MEDIA_LOCATION"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        // cf. https://developer.android.com/training/package-visibility/declaring
        if (SelectNodes("/manifest/queries", nsMgr).Count == 0) {
            var elem = CreateElement("queries");
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/queries/intent/action[@android:name='android.media.action.IMAGE_CAPTURE']", nsMgr).Count == 0) {
            var action = CreateElement("action");
            action.Attributes.Append(CreateAndroidAttribute("name", "android.media.action.IMAGE_CAPTURE"));
            var intent = CreateElement("intent");
            intent.AppendChild(action);
            var queries = SelectSingleNode("/manifest/queries") as XmlElement;
            queries.AppendChild(intent);
            changed = true;
        }
        return changed;
    }

    internal bool AddGallery() {
        bool changed = false;
        // for api level 33
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.READ_MEDIA_IMAGES']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.READ_MEDIA_IMAGES"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.READ_MEDIA_VIDEO']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.READ_MEDIA_VIDEO"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.READ_MEDIA_AUDIO']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.READ_MEDIA_AUDIO"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        // cf. https://developer.android.com/training/package-visibility/declaring
        if (SelectNodes("/manifest/queries", nsMgr).Count == 0) {
            var elem = CreateElement("queries");
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/queries/intent/action[@android:name='android.media.action.GET_CONTENT']", nsMgr).Count == 0) {
            var action = CreateElement("action");
            action.Attributes.Append(CreateAndroidAttribute("name", "android.media.action.GET_CONTENT"));
            var intent = CreateElement("intent");
            intent.AppendChild(action);
            var queries = SelectSingleNode("/manifest/queries") as XmlElement;
            queries.AppendChild(intent);
            changed = true;
        }
        return changed;
    }

    internal bool AddMicrophone() {
        bool changed = false;
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.MICROPHONE']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.MICROPHONE"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/uses-feature[@android:name='android.hardware.microphone']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-feature");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.hardware.microphone"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        // cf. https://github.com/gree/unity-webview/issues/679
        // cf. https://github.com/fluttercommunity/flutter_webview_plugin/issues/138#issuecomment-559307558
        // cf. https://stackoverflow.com/questions/38917751/webview-webrtc-not-working/68024032#68024032
        // cf. https://stackoverflow.com/questions/40236925/allowing-microphone-accesspermission-in-webview-android-studio-java/47410311#47410311
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.MODIFY_AUDIO_SETTINGS']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.MODIFY_AUDIO_SETTINGS"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        if (SelectNodes("/manifest/uses-permission[@android:name='android.permission.RECORD_AUDIO']", nsMgr).Count == 0) {
            var elem = CreateElement("uses-permission");
            elem.Attributes.Append(CreateAndroidAttribute("name", "android.permission.RECORD_AUDIO"));
            ManifestElement.AppendChild(elem);
            changed = true;
        }
        return changed;
    }
}
}
#endif
