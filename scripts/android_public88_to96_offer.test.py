#!/usr/bin/env python3
"""Local host and extracted-method controls, not Android runtime qualification."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOST = Path(os.environ.get("YAWF_OFFER_HOST_UNDER_TEST", ROOT / "scripts/android_public_ota_runtime_check.py"))
JAVA = Path(os.environ.get("YAWF_OFFER_JAVA_UNDER_TEST", ROOT / "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java"))
WORKFLOW = Path(os.environ.get("YAWF_OFFER_WORKFLOW_UNDER_TEST", ROOT / ".github/workflows/android-public88-to96-initial-offer.yml"))

# Public CI run 42894154678, 01-failure.xml SHA256 106ec65fc68be58b282fd48ff76e1bd5d87da2f408a59e630f44fd7074082e74.
# Only the non-PII native consent Button node is retained.
CAPTURED_ENABLE_BUTTON_XML = '''<node index="1" text="ENABLE" resource-id="android:id/button1"
 class="android.widget.Button" package="com.tgk30.debridstreamer" content-desc=""
 checkable="false" checked="false" clickable="true" enabled="true" focusable="true"
 focused="false" scrollable="false" long-clickable="false" password="false" selected="false"
 visible-to-user="true" bounds="[783,1040][978,1166]" drawing-order="4" hint="" display-id="0" />'''


# Run 42905575679 cleanup XML SHA256 51a20c90a8688fa1b04bc96232571a9d723a62f41578e826cada861d38e2a420.
# Complete 47-node owned Settings subtree; only non-PII selector/geometry attributes retained.
CAPTURED_APPS_WINDOW_XML = '''<node text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
 <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
  <node text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
   <node text="" resource-id="com.android.settings:id/content_parent" class="android.widget.ScrollView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="true" visible-to-user="true" bounds="[0,63][1080,1857]">
    <node text="" resource-id="com.android.settings:id/app_bar" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,63][1080,533]">
     <node text="" resource-id="com.android.settings:id/collapsing_toolbar" class="android.widget.FrameLayout" package="com.android.settings" content-desc="Apps" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,63][1080,533]">
      <node text="" resource-id="com.android.settings:id/action_bar" class="android.view.ViewGroup" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,63][1080,210]">
       <node text="" resource-id="" class="android.widget.ImageButton" package="com.android.settings" content-desc="Navigate up" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,63][147,210]" />
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,63][1080,210]" />
      </node>
     </node>
    </node>
    <node text="" resource-id="com.android.settings:id/content_frame" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,533][1080,1857]">
     <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,533][1080,1857]">
      <node text="" resource-id="com.android.settings:id/main_content" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,533][1080,1857]">
       <node text="" resource-id="com.android.settings:id/container_material" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,533][1080,1857]">
        <node text="" resource-id="android:id/list_container" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,533][1080,1857]">
         <node text="" resource-id="com.android.settings:id/recycler_view" class="androidx.recyclerview.widget.RecyclerView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="true" visible-to-user="true" bounds="[0,533][1080,1857]">
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,575][1080,668]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,575][1038,668]">
            <node text="Recently opened apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,596][1038,647]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,668][1080,874]">
           <node text="" resource-id="com.android.settings:id/icon_frame" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,718][189,824]">
            <node text="" resource-id="android:id/icon" class="android.widget.ImageView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,729][147,813]" />
           </node>
           <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,668][1038,874]">
            <node text="YAWF Stream" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,710][510,781]" />
            <node text="0 minutes ago" resource-id="android:id/summary" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,781][1038,832]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,874][1080,1029]">
           <node text="" resource-id="com.android.settings:id/icon_frame" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,909][189,994]">
            <node text="" resource-id="android:id/icon" class="android.widget.ImageView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,920][126,983]" />
           </node>
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,874][1038,1029]">
            <node text="See all 29 apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,916][546,987]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1071][1080,1164]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1071][1038,1164]">
            <node text="General" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1092][1038,1143]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1164][1080,1370]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1164][1038,1370]">
            <node text="Default apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1206][361,1277]" />
            <node text="Chrome, Phone, and Messages" resource-id="android:id/summary" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1277][569,1328]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1370][1080,1576]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1370][1038,1576]">
            <node text="Screen time" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1412][342,1483]" />
            <node text="3 minutes today" resource-id="android:id/summary" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1483][326,1534]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1576][1080,1782]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1576][1038,1782]">
            <node text="Cloud media app" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1618][461,1689]" />
            <node text="Google Photos" resource-id="android:id/summary" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1689][305,1740]" />
           </node>
          </node>
          <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1782][1080,1857]">
           <node text="" resource-id="" class="android.widget.RelativeLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1782][1038,1857]">
            <node text="Contacts storage" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[63,1824][466,1857]" />
           </node>
          </node>
         </node>
        </node>
       </node>
      </node>
     </node>
    </node>
   </node>
  </node>
 </node>
</node>
'''


# Run 42910612525 07-failure.xml SHA256 91f8a09a4737cb7ebe1dadaad986728483ee624e636285400a690133226ae750.
# Complete non-PII 16-node owned subtree.
CAPTURED_INSTALL_SUCCESS_XML = '''<node text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[28,700][1052,1220]">
 <node text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,742][1010,1178]">
  <node text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,742][1010,1178]">
   <node text="" resource-id="android:id/parentPanel" class="android.widget.LinearLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,742][1010,1178]">
    <node text="" resource-id="android:id/topPanel" class="android.widget.LinearLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,742][1010,873]">
     <node text="" resource-id="android:id/title_template" class="android.widget.LinearLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,742][1010,873]">
      <node text="" resource-id="android:id/icon" class="android.widget.ImageView" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[133,789][217,873]" />
      <node text="YAWF Stream" resource-id="android:id/alertTitle" class="android.widget.TextView" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[238,795][947,866]" />
     </node>
    </node>
    <node text="" resource-id="android:id/customPanel" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,873][1010,1014]">
     <node text="" resource-id="android:id/custom" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,873][1010,1014]">
      <node text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,873][1010,1014]">
       <node text="App installed." resource-id="com.android.packageinstaller:id/install_success" class="android.widget.TextView" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[133,894][387,951]" />
      </node>
     </node>
    </node>
    <node text="" resource-id="android:id/buttonPanel" class="android.widget.ScrollView" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,1014][1010,1178]">
     <node text="" resource-id="" class="android.widget.LinearLayout" package="com.google.android.packageinstaller" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[70,1014][1010,1178]">
      <node text="Done" resource-id="android:id/button2" class="android.widget.Button" package="com.google.android.packageinstaller" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[642,1025][810,1167]" />
      <node text="Open" resource-id="android:id/button1" class="android.widget.Button" package="com.google.android.packageinstaller" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[810,1025][978,1167]" />
     </node>
    </node>
   </node>
  </node>
 </node>
</node>
'''


# Run 42910612525 cleanup-failure.xml SHA256 4c8188751521dcf9b2710b5f311ab9bfd08944ae67199af786b29c74b6185f30.
# Complete non-PII 32-node owned subtree.
CAPTURED_CLEANUP_TARGET_XML = '''<node text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
 <node text="" resource-id="" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
  <node text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
   <node text="" resource-id="" class="androidx.compose.ui.platform.ComposeView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
    <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
     <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,1920]">
      <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,525][1080,1920]">
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,525][1080,1920]">
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,525][1080,724]">
         <node text="Chrome" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,572][380,634]" />
         <node text="Not allowed" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,639][387,682]" />
        </node>
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,724][1080,923]">
         <node text="Drive" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,771][312,833]" />
         <node text="Not allowed" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,838][387,881]" />
        </node>
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,923][1080,1122]">
         <node text="Gmail" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,970][330,1032]" />
         <node text="Not allowed" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,1037][387,1080]" />
        </node>
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,1122][1080,1321]">
         <node text="YAWF Stream" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,1169][517,1231]" />
         <node text="Allowed" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[189,1236][321,1279]" />
        </node>
       </node>
      </node>
      <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[0,0][1080,525]">
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[12,74][138,200]">
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="Navigate up" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[43,105][106,168]" />
        <node text="" resource-id="" class="android.widget.Button" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[22,84][127,189]" />
       </node>
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[148,99][769,173]" />
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[818,74][944,200]">
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="Search" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[849,105][912,168]" />
        <node text="" resource-id="" class="android.widget.Button" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[828,84][933,189]" />
       </node>
       <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="" clickable="true" enabled="true" scrollable="false" visible-to-user="true" bounds="[944,74][1070,200]">
        <node text="" resource-id="" class="android.view.View" package="com.android.settings" content-desc="More options" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[975,105][1038,168]" />
        <node text="" resource-id="" class="android.widget.Button" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[954,84][1059,189]" />
       </node>
       <node text="Install unknown apps" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="false" enabled="true" scrollable="false" visible-to-user="true" bounds="[64,361][952,477]" />
      </node>
     </node>
    </node>
   </node>
  </node>
 </node>
</node>
'''


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


host = module("android_public_ota_runtime_check", HOST)
admission = module("offer_admission_under_test", ROOT / "scripts/android_public88_to96_offer_admission.py")


def java_method(text, name):
    match = re.search(r"    private [^\n]*\b" + name + r"\([^)]*\) [^{]*\{", text)
    assert match is not None, name
    start = text.index("{", match.start())
    depth, end = 1, start + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[match.start():end]


def valid_apps_proof():
    return {
        "schemaVersion": 1, "status": "ready", "complete": True, "activeWindowCount": 1,
        "stableSamples": 2, "acquisitionActionLogDelta": 0, "appsTapActionLogDelta": 1,
        "startedAtUptimeMs": 10000, "deadlineUptimeMs": 100000,
        "preObservedAtUptimeMs": 10000, "tapCompletedAtUptimeMs": 10063,
        "readyAtUptimeMs": 12163, "polls": 23, "cacheRefreshes": 23,
        "preWindowId": 4, "readyWindowId": 5, "preNodeCount": 10, "readyNodeCount": 30,
        "displayWidth": 1080, "displayHeight": 1920, "kind": "scroll",
        "windowBounds": [0, 0, 1080, 1920], "candidateBounds": [0, 500, 1080, 1850],
    }


def valid_receipt():
    return {
        "appsWindowAcquisition": valid_apps_proof(), "cleanupFailureDiagnosticCaptured": False,
        "outcome": "passed", "persistentUiAutomationSession": True,
        "productPackage": "com.tgk30.debridstreamer",
        "runtimeProfile": "public88-to96-initial-offer-native-install-v1",
        "otaMode": "public88-to96-initial-offer-native-install-v1",
        "baselineVersion": "2.3.88",
        "baselineSourceRevision": "d045f783bbd7d91d215f713c2f3c919e72fac20b",
        "targetVersion": "2.3.96", "targetVersionCode": 2003096,
        "targetSha256": "e2b76d502b0fa10e90d47fb6158e456567be70c26421f64b106b56dd7c5fc4ef",
        "targetSize": 88710017, "targetIdentityAdmitted": True,
        "targetSourceRevision": "887ae66714d1352e66be203cd837a3de0c12f036",
        "targetManifestSha256": "535234bfa5cd195116b353ab1bf1de0035dee59bf258a819492436acccf8c7f7",
        "targetVerificationSha256": "b97e63be919300d74884dd4eb1b98dfb4fce5ce1911ec3897afebf377f588a2e",
        "targetBuildRun": 42867073313,
        "initialOfferEnableSelections": 1, "initialOfferObserved": True,
        "weeklyOnAtInitialOffer": True, "preOfferManualDiscoveries": 0,
        "productUpdateSelections": 1, "productInstallSelections": 1,
        "productPermissionPageObserved": True, "permissionEnabledByTest": True,
        "permissionBackReturnObserved": True, "legacyManualReconsentUsed": False,
        "systemUpdateSelections": 1, "systemOpenSelections": 1,
        "installerSuccessObserved": True, "installerOpenObserved": True,
        "updatedProductObserved": True, "permissionCleanupObserved": True,
        "permissionCleanupToggleSelections": 1, "cancellationProven": False,
        "dueResumeSchedulingProven": False, "dataStatePersistenceProven": False,
        "weeklyElapsedSchedulingProven": False, "independentColdProcessProof": False,
        "physicalDeviceProof": False, "captures": 9, "failure": None,
    }


class OfferHostTests(unittest.TestCase):
    def binding(self):
        return host.load_public88_to96_offer_binding(dict(host.PUBLIC88_TO96_OFFER_ADMISSION))

    def test_exact_profile_and_native_tuple_agree(self):
        binding = self.binding()
        self.assertEqual(binding.baseline_version, "2.3.88")
        self.assertEqual(binding.target_version, "2.3.96")
        self.assertNotEqual(binding.ota_mode, host.AUTOMATIC_OTA_MODE)
        text = java_method(JAVA.read_text(), "admitPublic88To96InitialOfferIdentity")
        pairs = dict(re.findall(r'\{"([A-Za-z0-9]+)", "([^"]+)"\}', text))
        for key, value in host.PUBLIC88_TO96_OFFER_ADMISSION.items():
            if key not in {"profile", "otaMode", "evidenceSubdir", "signerSha256"}:
                self.assertEqual(pairs[key], value, key)
        self.assertIn('{"runtimeProfile", PUBLIC88_TO96_OFFER_PROFILE}', text)
        self.assertIn('{"signerSha256", OtaFlowPolicy.SIGNER_SHA256}', text)

    def test_every_admission_field_is_exact_and_required(self):
        valid = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binding.json"
            path.write_text(json.dumps(valid))
            self.assertEqual(host.load_automatic_binding(path), self.binding())
            variants = [{**valid, "extra": "true"}]
            for key in valid:
                missing = dict(valid)
                del missing[key]
                variants.extend([missing, {**valid, key: "wrong"}, {**valid, key: 1}])
            for value in variants:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value))
                    with self.assertRaises(host.RuntimeGateError):
                        host.load_automatic_binding(path)

    def test_receipt_requires_every_fact_and_rejects_overclaims(self):
        binding, valid = self.binding(), valid_receipt()
        host.validate_receipt(valid, binding.ota_mode, binding)
        for key, value in valid.items():
            missing = dict(valid)
            del missing[key]
            wrong = not value if type(value) is bool else (value + 1 if type(value) is int else "wrong")
            wrong_type = (int(value) if type(value) is bool else
                          float(value) if type(value) is int else
                          1 if type(value) is str else str(value))
            for mutant in (missing, {**valid, key: wrong}, {**valid, key: wrong_type}):
                with self.subTest(key=key, mutant=mutant.get(key)):
                    with self.assertRaises(host.RuntimeGateError):
                        host.validate_receipt(mutant, binding.ota_mode, binding)
        with self.assertRaises(host.RuntimeGateError):
            host.validate_receipt({**valid, "initialManualCancelWon": True}, binding.ota_mode, binding)

    def test_old_cancel_lane_is_not_promoted(self):
        binding = self.binding()
        for mode in (host.AUTOMATIC_OTA_MODE, host.STRICT_OTA_MODE):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_receipt(valid_receipt(), mode, binding)
        with self.assertRaises(host.RuntimeGateError):
            host.validate_receipt(valid_receipt(), binding.ota_mode, host.LEGACY_BINDING)
        old = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        old["baselineVersion"] = "2.3.27"
        with self.assertRaises(host.RuntimeGateError):
            host.load_public88_to96_offer_binding(old)

    def test_only_fresh_owned_ci_emulator_context_is_admitted(self):
        self.binding()
        env = {"CI": "true", "GITHUB_ACTIONS": "true",
               "GITHUB_REPOSITORY": "Tgk-30/YAWF-Stream", "GITHUB_ACTOR": "Tgk-30",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ID": "123",
               "GITHUB_REF": "refs/heads/qa", "YAWF_PUBLIC88_TO96_OWNED_FRESH_EMULATOR": "true"}
        host.require_public88_to96_ci_emulator("emulator-5554", env)
        for key in env:
            for replacement in ("", "wrong"):
                with self.subTest(key=key, replacement=replacement):
                    with self.assertRaises(host.RuntimeGateError):
                        host.require_public88_to96_ci_emulator("emulator-5554", {**env, key: replacement})
        for serial in ("physical-device", "emulator-5556", "", "emulator-5554\n"):
            with self.assertRaises(host.RuntimeGateError):
                host.require_public88_to96_ci_emulator(serial, env)

    def test_admission_checks_actual_inputs_before_returning_a_binding(self):
        args = argparse.Namespace(profile=host.PUBLIC88_TO96_OFFER_PROFILE)
        with patch.object(host, "validate_host_inputs") as validate:
            self.assertEqual(admission.admit(args), host.PUBLIC88_TO96_OFFER_ADMISSION)
            validate.assert_called_once_with(args, self.binding())
        with patch.object(host, "validate_host_inputs", side_effect=host.RuntimeGateError("bad bytes")):
            with self.assertRaises(host.RuntimeGateError):
                admission.admit(args)
        args.profile = host.AUTOMATIC_OTA_MODE
        with self.assertRaises(host.RuntimeGateError):
            admission.admit(args)

    def test_install_aliases_transfers_and_second_baseline_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ("baseline", "target", "app", "test")]
            for index, path in enumerate(paths):
                path.write_bytes(f"inert-{index}".encode())
            binding = dataclasses.replace(self.binding(), baseline_sha256=host.sha256_file(paths[0]),
                                          target_sha256=host.sha256_file(paths[1]))
            def wrapper(inputs=paths):
                return host.AdmittedAdb("never-executed", "emulator-5554", *inputs,
                                        automatic_binding=binding)
            adb = wrapper()
            for index in (0, 2, 3):
                inputs = paths.copy()
                inputs[index] = paths[1]
                with self.assertRaises(host.RuntimeGateError):
                    wrapper(inputs)
                saved = paths[index].read_bytes()
                paths[index].write_bytes(paths[1].read_bytes())
                with self.assertRaises(host.RuntimeGateError):
                    wrapper()
                paths[index].write_bytes(saved)
            with patch.object(adb, "_execute", return_value=subprocess.CompletedProcess([], 0, "Success", "")) as execute:
                adb.install_harness(host.sha256_file(paths[2]), host.sha256_file(paths[3]))
                adb.install_baseline_once()
                self.assertEqual(execute.call_count, 3)
                with self.assertRaises(host.RuntimeGateError):
                    adb.install_baseline_once()
                for command in (["install", str(paths[1])], ["push", str(paths[1]), "/data/local/tmp/x"],
                                ["sync"], ["shell", "pm", "clear", host.PRODUCT_PACKAGE],
                                ["shell", "am", "start", "-a", "android.intent.action.INSTALL_PACKAGE"],
                                ["shell", "date", "-s", "20260101"]):
                    with self.assertRaises(host.RuntimeGateError):
                        adb.run(command)
                self.assertEqual(execute.call_count, 3)
                with self.assertRaises(host.RuntimeGateError):
                    adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final.apk")
                with self.assertRaises(host.RuntimeGateError):
                    adb.mark_installer_success_receipt()
                adb.automatic_instrumentation_started = True
                adb.mark_installer_success_receipt()
                adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final.apk")
                self.assertEqual(execute.call_count, 4)
                with self.assertRaises(host.RuntimeGateError):
                    adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final-again.apk")
                with self.assertRaises(host.RuntimeGateError):
                    adb.mark_installer_success_receipt()

    def test_exact_instrumentation_and_installer_receipt_gate_final_pull(self):
        binding = self.binding()
        args = host.automatic_instrumentation_arguments(binding)
        self.assertIn(host.PUBLIC88_TO96_OFFER_PROFILE, args)
        self.assertIn(binding.baseline_source, args)
        self.assertNotIn(host.AUTOMATIC_OTA_MODE, args)
        driver = inspect.getsource(host.OtaRuntimeDriver.run_instrumentation)
        self.assertLess(driver.index("validate_receipt("), driver.index("mark_installer_success_receipt("))
        final = inspect.getsource(host.OtaRuntimeDriver.verify_final)
        self.assertIn("validate_final_identity(baseline, final, self.binding)", final)
        self.assertIn("self.binding.target_sha256", final)
        baseline = host.PackageIdentity("2.3.88", 2003088, 10123, "first", "old-update")
        target = host.PackageIdentity("2.3.96", 2003096, 10123, "first", "new-update")
        host.validate_final_identity(baseline, target, binding)
        for field, value in (("uid", 10124), ("first_install_time", "changed"),
                             ("last_update_time", "old-update"), ("version_code", 2003088),
                             ("version_name", "2.3.88")):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_final_identity(baseline, dataclasses.replace(target, **{field: value}), binding)

    def test_all_nine_native_capture_pairs_are_required(self):
        self.binding()
        labels = ("initial-offer-consent", "initial-public-target-offer", "initial-offer-ready",
                  "unknown-source-before", "unknown-source-after", "installer-confirm",
                  "installer-success", "initial-offer-updated-product", "automatic-permission-cleanup-off")
        names = ["actions.txt", "instrumentation-receipt.json"] + [
            f"{i:02d}-{label}.{ext}" for i, label in enumerate(labels, 1) for ext in ("png", "xml")]
        host.validate_public88_to96_evidence_names(names)
        for index in range(len(names)):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_public88_to96_evidence_names(names[:index] + names[index + 1:])
        for extra in ("failure.png", names[0], "../01-initial-offer-consent.png"):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_public88_to96_evidence_names(names + [extra])

    def test_legacy_native_flow_and_guard_bodies_are_unchanged(self):
        expected = {
            "isAutomaticMode": "ca8ed8fc3a4418c66695fbe1eead4b8e1846a1865c99e9f32514f910b6a62a80",
            "admitAutomaticTargetIdentity": "a3e6fefbb262b551dc2d8359a392d6616ab25cb1f865281d727efeb6db7032ef",
            "runAutomaticFlow": "529391f694148397473477da6faf4a5be704184955890a24005ec9df579a2f69",
            "cancelInitialManualCheckBeforeResult": "a7872e6ddc783769ede6026a398ab6a6284802a7f07f939a3500843c7ce57cd0",
            "enterUnknownSourcePermission": "5ad5f3ef81148c4dca66fd5e91733659d529df5c2259b7de798958778ba8f521",
            "confirmSystemInstaller": "30f967619be194a72353c1270cfb6fc8476a999cb6bc010f7ba0acf952abcfb8",
            "cleanupUnknownSourcePermissionThroughVisibleSettings": "57ef75295fbf9146bb965027eda16320082ce2b662ca92d4a703be32a2b3f45b",
            "assertNoBindingTerms": "e6cb09c7b430e7e0061b93bdc2eef33c125a4877ab9795bb9bf105c3a6ab429d",
            "click": "f7d34e8b80e13877cbc16e144bd0862befe04b99ec8e8b4aa6ab257dd2b73d14",
            "waitFor": "5553ff4278afe8cd92c4e8ecc1bb0452dc5ae473506b69d5d189e44dfb00c660",
        }
        for name, digest in expected.items():
            body = java_method(JAVA.read_text(), name)
            if name == "cleanupUnknownSourcePermissionThroughVisibleSettings":
                body = body.replace("        if (isPublic88To96OfferMode()) captureInitialOfferPreAppsWindow();\n", "")
                body = body.replace("        if (isPublic88To96OfferMode()) awaitInitialOfferAppsWindow();\n", "")
                body = body.replace("        if (isPublic88To96OfferMode()) awaitInitialOfferCleanupTarget();\n", "")
            if name == "confirmSystemInstaller" and "awaitInitialOfferInstallerSuccess(installerPackage);" in body:
                start = body.index("        if (isPublic88To96OfferMode()) {", body.index("systemUpdateSelections++"))
                end = body.index("        installerSuccessObserved = true;", start)
                branch = body[start:end]
                old = branch[branch.index("        } else {\n") + len("        } else {\n"):-len("        }\n")]
                old = "\n".join(line[4:] for line in old.splitlines()) + "\n"
                body = body[:start] + old + body[end:]
            self.assertEqual(hashlib.sha256(body.encode()).hexdigest(), digest, name)

    def test_native_dispatch_and_nonclaims_remain_separate(self):
        self.binding()
        text = JAVA.read_text()
        entry = text[text.index("Throwable primary = null;"):text.index("} catch (Throwable caught)")]
        self.assertRegex(entry, r"if \(isPublic88To96OfferMode\(\)\) \{\s+runPublic88To96InitialOfferFlow\(\);\s+\} else if \(isAutomaticMode\(\)\)")
        receipt = java_method(text, "writeReceipt")
        self.assertIn("if (isAutomaticMode())", receipt)
        self.assertNotIn("isPublic88To96OfferMode", java_method(text, "isAutomaticMode"))
        self.assertNotIn("isPublic88To96OfferMode", java_method(text, "admitAutomaticTargetIdentity"))
        self.assertEqual(text.count("isAutomaticMode()"), 6)
        self.assertIn("if (isAutomaticMode() || isPublic88To96OfferMode())", text)
        appended = java_method(text, "appendPublic88To96OfferReceipt")
        self.assertIn("appendPublic88To96OfferReceipt(receipt);", receipt)
        shared = receipt[:receipt.index("if (isAutomaticMode())")]
        fields = set(re.findall(r'receipt\.put\(\s*"([^"]+)"', shared + appended)) | {"captures", "failure"}
        self.assertEqual(fields, set(valid_receipt()))
        for key in ("cancellationProven", "dueResumeSchedulingProven", "dataStatePersistenceProven",
                    "weeklyElapsedSchedulingProven", "independentColdProcessProof", "physicalDeviceProof"):
            self.assertIn(f'receipt.put("{key}", false);', appended)
            self.assertIn(f'"{key}": False', inspect.getsource(host.OtaRuntimeDriver.run))
        self.assertIn('"persistenceProof": "not-qualified"', inspect.getsource(host.OtaRuntimeDriver.run))
        flow = java_method(text, "runPublic88To96InitialOfferFlow")
        for forbidden in ("cancelInitialManualCheckBeforeResult", "runAutomaticFlow", "completeNormalSetupExact",
                          "seedMeaningfulLocalState", "returnToProductThroughVisibleLauncher", "pressBack", "pressHome"):
            self.assertTrue(forbidden not in flow, forbidden)

    def test_apps_proof_is_exact_bounded_and_cannot_promote_old_or_partial_windows(self):
        valid = valid_apps_proof()
        self.assertIs(host.validate_initial_offer_apps_acquisition(valid), valid)
        for key in valid:
            missing = dict(valid); del missing[key]
            with self.subTest(missing=key), self.assertRaises(host.RuntimeGateError):
                host.validate_initial_offer_apps_acquisition(missing)
            with self.subTest(wrongtype=key), self.assertRaises(host.RuntimeGateError):
                host.validate_initial_offer_apps_acquisition({**valid, key: None})
        variants = [
            {"extra": 1}, {"complete": False}, {"activeWindowCount": 2}, {"stableSamples": 1},
            {"acquisitionActionLogDelta": 1}, {"appsTapActionLogDelta": 2}, {"cacheRefreshes": 22},
            {"preWindowId": 5}, {"readyWindowId": -1}, {"preNodeCount": 0}, {"readyNodeCount": 513},
            {"polls": 903}, {"deadlineUptimeMs": 100001}, {"readyAtUptimeMs": 100000},
            {"readyAtUptimeMs": 10064}, {"tapCompletedAtUptimeMs": 9999}, {"kind": "unknown"},
            {"windowBounds": [-1, 0, 1080, 1920]}, {"candidateBounds": [0, 0, 1081, 1900]},
            {"candidateBounds": [3, 3, 3, 4]}, {"windowBounds": [0, 501, 1080, 1920]},
            {"stableSamples": True}, {"complete": 1},
        ]
        for change in variants:
            with self.subTest(change=change), self.assertRaises(host.RuntimeGateError):
                host.validate_initial_offer_apps_acquisition({**valid, **change})
        producer = java_method(JAVA.read_text(), "initialOfferAppsProof")
        marker = "if (gate.ready == null && gate.lastSnapshot != null)"
        start = producer.index(marker); end = producer.index("{", start) + 1; depth = 1
        while depth:
            depth += (producer[end] == "{") - (producer[end] == "}"); end += 1
        self.assertEqual(set(re.findall(r'proof\.put\("([^"]+)"', producer[start:end])), {
            "failureReason", "observedActiveWindows", "observedHeaders", "observedScrolls", "observedOuters", "observedInners"})
        producer = producer[:start] + producer[end:]
        self.assertEqual(set(re.findall(r'proof\.put\("([^"]+)"', producer)), set(valid))

    def test_cleanup_failure_evidence_is_readable_only_in_new_profile_and_never_passes(self):
        binding = self.binding()
        for name in ("cleanup-failure.png", "cleanup-failure.xml"):
            self.assertTrue(host.admitted_harness_evidence_name(name, binding))
            self.assertFalse(host.admitted_harness_evidence_name(name, host.LEGACY_BINDING))
            self.assertFalse(host.admitted_harness_evidence_name("../" + name, binding))
            self.assertFalse(host.admitted_harness_evidence_name(name + ".bak", binding))
        value = valid_receipt(); value["cleanupFailureDiagnosticCaptured"] = True
        with self.assertRaises(host.RuntimeGateError):
            host.validate_receipt(value, binding.ota_mode, binding)
        source = JAVA.read_text()
        cleanup = java_method(source, "cleanupUnknownSourcePermissionThroughVisibleSettings")
        self.assertLess(cleanup.index("captureInitialOfferPreAppsWindow()"), cleanup.index('clickSystemText("Apps"'))
        self.assertLess(cleanup.index("awaitInitialOfferAppsWindow()"), cleanup.index('scrollUntilVisibleSystemText("Special app access"'))
        diagnostic = java_method(source, "captureInitialOfferCleanupFailure")
        self.assertNotIn("captureIndex", diagnostic)
        self.assertNotIn('capture("', diagnostic)
        self.assertIn('new File(evidenceDir, "cleanup-failure.xml")', diagnostic)

    def test_workflow_is_separate_fixed_and_fresh_ci_only(self):
        self.binding()
        text = WORKFLOW.read_text()
        for expected in ("inputs.profile == 'public88-to96-initial-offer-native-install-v1'",
                         "github.event_name == 'workflow_dispatch' &&",
                         "BASELINE_VERSION: 2.3.88", 'BASELINE_VERSION_CODE: "2003088"',
                         "TARGET_VERSION: 2.3.96", 'TARGET_VERSION_CODE: "2003096"',
                         'persistenceProof=not-qualified', 'cancellationProof=not-qualified',
                         'dueResumeSchedulingProof=not-qualified', 'freshOwnedEmulator=true',
                         'YAWF_PUBLIC88_TO96_OWNED_FRESH_EMULATOR=true', 'test -c /dev/kvm',
                         'adb devices |', '-no-snapshot', 'SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64'):
            self.assertTrue(expected in text, expected)
        for env, key in (("BASELINE_SOURCE_SHA", "baselineSourceRevision"),
                         ("BASELINE_APK_SHA256", "baselineSha256"), ("BASELINE_APK_SIZE", "baselineSize"),
                         ("TARGET_SOURCE_SHA", "targetSourceRevision"), ("TARGET_APK_SHA256", "targetSha256"),
                         ("TARGET_APK_SIZE", "targetSize"), ("TARGET_BUILD_RUN", "targetBuildRun"),
                         ("TARGET_MANIFEST_SHA256", "targetManifestSha256"),
                         ("TARGET_VERIFICATION_SHA256", "targetVerificationSha256")):
            value = re.escape(host.PUBLIC88_TO96_OFFER_ADMISSION[key])
            self.assertRegex(text, rf'(?m)^      {env}: "?{value}"?$')
        host_job = text[text.index("  bounded-host-policy:"):text.index("  public88-to96-initial-offer-api36:")]
        self.assertIn("github.event_name == 'push'", host_job)
        self.assertIn("github.ref == 'refs/heads/codex/ota88-96-offer'", host_job)
        for forbidden in ("setup-android", "sdkmanager", "emulator ", "adb ", "gradle "):
            self.assertTrue(forbidden not in host_job, forbidden)
        self.assertLess(text.index("android_public88_to96_offer_admission.py"), text.index("uses: android-actions/setup-android"))
        self.assertLess(text.index("adb devices |"), text.index("avdmanager create avd"))
        self.assertEqual(text.count("--baseline-apk"), 4)
        for forbidden in ("cancelInitialManualCheckBeforeResult", "adb install", "adb push", "adb sync",
                          "pm clear", "android.intent.action.INSTALL_PACKAGE", "inputs.target_", "date -s", "--ota-mode"):
            self.assertTrue(forbidden not in text, forbidden)


class ExtractedNativeFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
        javac = str(Path(home) / "bin/javac") if (Path(home) / "bin/javac").is_file() else shutil.which("javac")
        assert javac is not None, "JDK 17 or newer is required for the local extracted-method controls"
        java = str(Path(javac).with_name("java"))
        cls.java = java
        cls.temporary = tempfile.TemporaryDirectory(prefix="ota88-offer-methods-")
        cls.directory = Path(cls.temporary.name)
        text = JAVA.read_text()
        methods = "\n".join(java_method(text, name) for name in (
            "isAutomaticMode", "isPublic88To96OfferMode", "isFixed42AutomaticMode",
            "isFixed42To59AutomaticMode", "isFixed42To61AutomaticMode", "isFixed42To74AutomaticMode",
            "launchProductFromVisibleLauncher", "admitPublic88To96InitialOfferIdentity",
            "requireInitialOfferSingle", "runPublic88To96InitialOfferFlow"))
        entry = text[text.index('        otaMode = arguments.getString("otaMode", "strict");'):
                     text.index("        Context targetContext = instrumentation.getTargetContext();")]
        methods += "\n private void exerciseActualEntryAdmission(Bundle arguments){\n" + entry + "\n  assertEquals(\"own evidence\",PUBLIC88_TO96_OFFER_EVIDENCE,subdir);\n }\n"
        native_args = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        native_args["runtimeProfile"] = native_args.pop("profile")
        bundle = "\n".join(f"  b.put({json.dumps(key)},{json.dumps(value)});" for key, value in native_args.items())
        captured_button = "\n".join(
            f"  node.put({json.dumps(key)},{json.dumps(value)});"
            for key, value in ET.fromstring(CAPTURED_ENABLE_BUTTON_XML).attrib.items())
        probe = r'''
import java.util.*;
import java.util.regex.Pattern;
public final class OfferProbe {
 static final String PUBLIC88_TO96_OFFER_PROFILE="public88-to96-initial-offer-native-install-v1";
 static final String PUBLIC88_TO96_OFFER_EVIDENCE="public88-to96-initial-offer";
 static final String AUTOMATIC_OTA_MODE="automatic-initial-cancel-due-resume", AUTOMATIC_EVIDENCE_SUBDIR="automatic-public-ota-flow", EVIDENCE_SUBDIR="persistent-ota-flow";
 static final String FIXED42_AUTOMATIC_OTA_PROFILE="public-fixed42-to59-initial-cancel-due-resume-v1", FIXED42_TO61_AUTOMATIC_OTA_PROFILE="public-fixed42-to61-initial-cancel-due-resume-v1", FIXED42_TO74_AUTOMATIC_OTA_PROFILE="public-fixed42-to74-initial-cancel-due-resume-v1";
 static final String FIXED42_EVIDENCE_SUBDIR="fixed42-automatic-public-ota-flow", FIXED42_TO61_EVIDENCE_SUBDIR="fixed42-to61-automatic-public-ota-flow", FIXED42_TO74_EVIDENCE_SUBDIR="fixed42-to74-automatic-public-ota-flow";
 static final Pattern SAFE_SUBDIR=Pattern.compile("[A-Za-z0-9._-]{1,64}");
 static final long UI_WAIT_MS=90000, SHORT_WAIT_MS=20000, DOWNLOAD_WAIT_MS=480000;
 static String fault="";
 String otaMode=PUBLIC88_TO96_OFFER_PROFILE;
 String admittedBaselineVersion, admittedBaselineSourceRevision, admittedTargetVersion;
 String admittedTargetSha256, admittedTargetSourceRevision, admittedTargetManifestSha256, admittedTargetVerificationSha256;
 long admittedTargetVersionCode, admittedTargetSize, admittedTargetBuildRun;
 boolean targetIdentityAdmitted, initialOfferObserved, weeklyOnAtInitialOffer;
 boolean legacyManualReconsentUsed, updatedProductObserved;
 int initialOfferEnableSelections, preOfferManualDiscoveries, productUpdateSelections, productInstallSelections;
 final List<String> actions=new ArrayList<>();
 final UiDevice device=new UiDevice();
 static final class OtaFlowPolicy {
  static final String PRODUCT_PACKAGE="com.tgk30.debridstreamer", UPDATE="Update", INSTALL="Install";
  static final String SIGNER_SHA256="233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a";
  static final String BASELINE_VERSION="2.3.25", TARGET_VERSION="2.3.26", TARGET_SHA256="legacy";
  static final long TARGET_VERSION_CODE=2003026, TARGET_SIZE=1;
  static boolean matchesVersionPins(Object... ignored){return false;}
 }
 static class Bundle extends HashMap<String,String> { String getString(String key,String fallback){return getOrDefault(key,fallback);} }
 static final class BySelector {
  String text, resource, packageName, className;
  Boolean clickable, enabled;
  BySelector(String s){text=s;}
  BySelector pkg(String s){packageName=s;return this;} BySelector clazz(String s){className=s;return this;}
  BySelector text(String s){text=s;return this;}
  BySelector clickable(boolean b){clickable=b;return this;} BySelector enabled(boolean b){enabled=b;return this;}
  boolean matches(Map<String,String> node){
   return (text==null||text.equals(node.get("text")))
    &&(resource==null||resource.equals(node.get("resource-id")))
    &&(packageName==null||packageName.equals(node.get("package")))
    &&(className==null||className.equals(node.get("class")))
    &&(clickable==null||clickable.toString().equals(node.get("clickable")))
    &&(enabled==null||enabled.toString().equals(node.get("enabled")));
  }
 }
 static final class By {
  static BySelector res(String a,String b){BySelector s=new BySelector(null);s.resource=a+":id/"+b;return s;}
  static BySelector text(String s){return new BySelector(s);}
  static BySelector pkg(String s){return new BySelector(s);}
 }
 static Map<String,String> capturedEnableNode(){
  Map<String,String> node=new HashMap<>();
'''+captured_button+r'''
  if(fault.equals("enable-foreign"))node.put("package","foreign.package");
  if(fault.equals("enable-disabled"))node.put("enabled","false");
  if(fault.equals("enable-wrong-label"))node.put("text","ENABLE NOW");
  if(fault.equals("enable-wrong-prefix"))node.put("text","XENABLE");
  if(fault.equals("enable-titlecase"))node.put("text","Enable");
  if(fault.equals("enable-wrong-resource"))node.put("resource-id","android:id/button2");
  if(fault.equals("enable-wrong-class"))node.put("class","android.widget.TextView");
  if(fault.equals("enable-nonclickable"))node.put("clickable","false");
  if(fault.equals("enable-missing-label"))node.remove("text");
  return node;
 }
 static final class UiObject2 { boolean isChecked(){return !fault.equals("weekly-off");} }
 static final class UiDevice {
  void wakeUp(){}
  String getCurrentPackageName(){return fault.equals("foreign")?"foreign.package":OtaFlowPolicy.PRODUCT_PACKAGE;}
  List<UiObject2> findObjects(BySelector selector){
   if(fault.equals("missing"))return List.of();
   if(selector.resource!=null){
    Map<String,String> node=capturedEnableNode();
    List<UiObject2> matches=new ArrayList<>();
    if(selector.matches(node)){
     matches.add(new UiObject2());
     if(fault.equals("enable-duplicate"))matches.add(new UiObject2());
    }
    System.out.println("CAPTURED_ENABLE_MATCH_COUNT="+matches.size());
    return matches;
   }
   return fault.equals("duplicate")?List.of(new UiObject2(),new UiObject2()):List.of(new UiObject2());
  }
 }
 static void assertTrue(String label,boolean condition){if(!condition)throw new AssertionError(label);}
 static void assertFalse(String label,boolean condition){assertTrue(label,!condition);}
 static void assertEquals(String label,Object a,Object b){assertTrue(label,Objects.equals(a,b));}
 static long parseLongArgument(Bundle b,String key){return Long.parseLong(b.getString(key,""));}
 void assertNoBindingTerms(){assertTrue("terms",!fault.equals("binding-terms"));}
 void admitAutomaticTargetIdentity(Bundle b){throw new AssertionError("old automatic admission must not run");}
 void launchFixed42ProductFromVisibleLauncher(String phase){throw new AssertionError("old fixed42 launcher must not run");}
 void launchVisibleAppFromLauncher(String label,String pkg,String phase){assertEquals("launcher product package",OtaFlowPolicy.PRODUCT_PACKAGE,pkg);assertEquals("launcher product label","YAWF Stream",label);actions.add("launch");}
 BySelector nativeDialogText(String text){return By.text(text);}
 BySelector nativeProductButton(String text){return By.text(text);}
 UiObject2 waitFor(BySelector selector,long timeout,String label){
  assertTrue("no transient progress dependency",!selector.text.equals("Checking for updates")&&!selector.text.equals("Downloading update"));
  if(fault.equals("no-offer")&&label.equals("exact initial public target offer"))throw new AssertionError("offer timeout");
  if(selector.text.equals("Update ready to install"))assertTrue("ready only after Update",actions.contains("click:Update"));
  if(selector.text.equals(OtaFlowPolicy.PRODUCT_PACKAGE))assertTrue("open only after installer",actions.contains("installer"));
  return new UiObject2();
 }
 void capture(String label){actions.add("capture:"+label);}
 void click(BySelector selector,String label,long timeout,boolean enabled){actions.add("click:"+selector.text);}
 void enterUnknownSourcePermission(){assertTrue("permission only after Install",actions.contains("click:Install"));actions.add("permission");}
 void confirmSystemInstaller(){assertTrue("installer only after permission",actions.contains("permission"));actions.add("installer");}
'''+methods+r'''
 public static void main(String[] args)throws Exception {
  fault=args[0]; OfferProbe p=new OfferProbe();
  Bundle b=new Bundle();
'''+bundle+r'''
  if(fault.startsWith("bad-identity:"))b.put(fault.substring("bad-identity:".length()),"wrong");
  p.exerciseActualEntryAdmission(b);
  assertFalse("new profile is not the old automatic mode",p.isAutomaticMode());
  assertEquals("admitted baseline","2.3.88",p.admittedBaselineVersion);
  assertEquals("admitted baseline source","d045f783bbd7d91d215f713c2f3c919e72fac20b",p.admittedBaselineSourceRevision);
  assertEquals("admitted target","2.3.96",p.admittedTargetVersion);
  assertEquals("admitted code",2003096L,p.admittedTargetVersionCode);
  assertEquals("admitted size",88710017L,p.admittedTargetSize);
  assertEquals("admitted digest","e2b76d502b0fa10e90d47fb6158e456567be70c26421f64b106b56dd7c5fc4ef",p.admittedTargetSha256);
  assertEquals("admitted source","887ae66714d1352e66be203cd837a3de0c12f036",p.admittedTargetSourceRevision);
  assertEquals("admitted manifest","535234bfa5cd195116b353ab1bf1de0035dee59bf258a819492436acccf8c7f7",p.admittedTargetManifestSha256);
  assertEquals("admitted verification","b97e63be919300d74884dd4eb1b98dfb4fce5ce1911ec3897afebf377f588a2e",p.admittedTargetVerificationSha256);
  assertEquals("admitted build",42867073313L,p.admittedTargetBuildRun);
  if(fault.equals("unadmitted"))p.targetIdentityAdmitted=false;
  if(fault.equals("wrong-profile"))p.otaMode="automatic-initial-cancel-due-resume";
  if(fault.equals("repeat-enable"))p.initialOfferEnableSelections=1;
  if(fault.equals("repeat-update"))p.productUpdateSelections=1;
  if(fault.equals("repeat-install"))p.productInstallSelections=1;
  try {p.runPublic88To96InitialOfferFlow();}
  catch(AssertionError failure){
   List<String> rejectedClicks=new ArrayList<>();for(String a:p.actions)if(a.startsWith("click:"))rejectedClicks.add(a);
   System.err.println("REJECTED_CLICKS="+rejectedClicks);throw failure;
  }
  assertTrue("offer observed",p.initialOfferObserved&&p.weeklyOnAtInitialOffer&&p.updatedProductObserved);
  assertEquals("Enable exactly once",1,p.initialOfferEnableSelections);
  assertEquals("Update exactly once",1,p.productUpdateSelections);
  assertEquals("Install exactly once",1,p.productInstallSelections);
  List<String> clicks=new ArrayList<>();for(String a:p.actions)if(a.startsWith("click:"))clicks.add(a);
  assertEquals("ordinary product sequence",List.of("click:ENABLE","click:Update","click:Install"),clicks);
  System.out.println("PASS initial-offer sequence without transient progress");
 }
}
'''
        source = cls.directory / "OfferProbe.java"
        source.write_text(probe)
        result = subprocess.run([javac, "-d", str(cls.directory), str(source)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_probe(self, fault):
        return subprocess.run([self.java, "-cp", str(self.directory), "OfferProbe", fault],
                              capture_output=True, text=True, timeout=10)

    def test_exact_native_flow_accepts_offer_without_transient_checking(self):
        result = self.run_probe("valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS initial-offer sequence", result.stdout)

    def test_captured_public88_enable_xml_matches_actual_new_selector(self):
        node = ET.fromstring(CAPTURED_ENABLE_BUTTON_XML)
        self.assertEqual(node.get("text"), "ENABLE")
        self.assertEqual(node.get("resource-id"), "android:id/button1")
        result = self.run_probe("valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CAPTURED_ENABLE_MATCH_COUNT=1", result.stdout)

    def test_captured_enable_selector_refuses_invalid_exact_nodes_before_input(self):
        self.assertEqual(self.run_probe("valid").returncode, 0)
        for fault in ("enable-foreign", "enable-disabled", "enable-duplicate", "enable-wrong-label",
                      "enable-wrong-prefix", "enable-titlecase", "enable-wrong-resource",
                      "enable-wrong-class", "enable-nonclickable", "enable-missing-label"):
            with self.subTest(fault=fault):
                result = self.run_probe(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                self.assertIn("REJECTED_CLICKS=[]", result.stderr)
                self.assertIn("CAPTURED_ENABLE_MATCH_COUNT=" + ("2" if fault == "enable-duplicate" else "0"), result.stdout)

    def test_native_flow_rejects_foreign_duplicate_missing_or_unadmitted_state(self):
        self.assertEqual(self.run_probe("valid").returncode, 0)
        fields = set(host.PUBLIC88_TO96_OFFER_ADMISSION) - {"profile"} | {"runtimeProfile"}
        faults = ("foreign", "duplicate", "missing", "weekly-off", "binding-terms", "no-offer",
                  "unadmitted", "wrong-profile", "repeat-enable", "repeat-update", "repeat-install")
        for fault in (*faults, *("bad-identity:" + field for field in sorted(fields))):
            with self.subTest(fault=fault):
                result = self.run_probe(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                if fault in {"foreign", "duplicate", "missing", "binding-terms", "unadmitted",
                             "wrong-profile", "repeat-enable"}:
                    self.assertIn("REJECTED_CLICKS=[]", result.stderr)
                elif fault in {"weekly-off", "no-offer", "repeat-update"}:
                    self.assertIn("REJECTED_CLICKS=[click:ENABLE]", result.stderr)
                elif fault == "repeat-install":
                    self.assertIn("REJECTED_CLICKS=[click:ENABLE, click:Update]", result.stderr)


class AppsWindowAcquisitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="ota88-apps-acquisition-")
        cls.directory = Path(cls.temporary.name)
        home = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
        javac = str(Path(home) / "bin/javac") if (Path(home) / "bin/javac").is_file() else shutil.which("javac")
        assert javac is not None
        cls.java = str(Path(javac).with_name("java"))
        text = JAVA.read_text()
        classes = []
        for name in ("AppsWindowSnapshot", "AppsWindowGate"):
            start = text.index("    private static final class " + name)
            body = text.index("{", start); depth = 1; end = body + 1
            while depth:
                depth += (text[end] == "{") - (text[end] == "}"); end += 1
            classes.append(text[start:end])
        methods = "\n".join(java_method(text, name) for name in (
            "collectAppsWindow", "readInitialOfferAppsWindow", "initialOfferAppsClock",
            "captureInitialOfferPreAppsWindow", "awaitInitialOfferAppsWindow"))
        captured_root = ET.fromstring(CAPTURED_APPS_WINDOW_XML)
        captured_nodes = list(captured_root.iter("node"))
        cls.captured_node_count = len(captured_nodes)
        factory = [" static AccessibilityNodeInfo capturedBody(int id){"]
        for index, node in enumerate(captured_nodes):
            bounds = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", node.get("bounds", ""))
            assert bounds is not None
            factory.append(f'  AccessibilityNodeInfo n{index}=node(id,{json.dumps(node.get("text", ""))},new Rect({",".join(bounds.groups())}));')
            for field, attribute in (("pkg", "package"), ("clazz", "class"), ("description", "content-desc"), ("resource", "resource-id")):
                factory.append(f'  n{index}.{field}={json.dumps(node.get(attribute, ""))};')
            for field, attribute in (("visible", "visible-to-user"), ("enabled", "enabled"), ("clickable", "clickable"), ("scrollable", "scrollable")):
                factory.append(f'  n{index}.{field}={node.get(attribute, "false")};')
        for parent in captured_nodes:
            for child in parent:
                factory.append(f'  n{captured_nodes.index(parent)}.children.add(n{captured_nodes.index(child)});')
        factory.append("  return n0;\n }")
        probe = r'''
import java.util.*;
public final class AppsProbe {
 static final long UI_WAIT_MS=90000;
 static long time=10000;
 static boolean tapped;
 static String scenario;
 final FakeInstrumentation instrumentation=new FakeInstrumentation();
 final FakeDevice device=new FakeDevice();
 final List<String> actions=new ArrayList<>();
 AppsWindowGate appsWindowGate;
 int appsPreActionDelta, appsPostActionDelta, appsPreActionCount, appsTapActionDelta;
 static class OtaFlowPolicy {static final String SETTINGS_PACKAGE="com.android.settings";}
 static class Build {static class VERSION {static final int SDK_INT=36;}static class VERSION_CODES {static final int UPSIDE_DOWN_CAKE=34;}}
 static class SystemClock {
  static long uptimeMillis(){return time;}
  static void sleep(long ms){if(ms<=0||ms>100)throw new AssertionError("unbounded/blind poll");time+=ms;}
 }
 static class Rect {
  int left,top,right,bottom;
  Rect(){} Rect(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}
  void set(Rect r){left=r.left;top=r.top;right=r.right;bottom=r.bottom;}
  boolean isEmpty(){return left>=right||top>=bottom;}
  boolean contains(Rect r){return !r.isEmpty()&&left<=r.left&&top<=r.top&&right>=r.right&&bottom>=r.bottom;}
  public boolean equals(Object o){if(!(o instanceof Rect))return false;Rect r=(Rect)o;return left==r.left&&top==r.top&&right==r.right&&bottom==r.bottom;}
 }
 static class AccessibilityNodeInfo {
  String pkg="com.android.settings",text="",clazz="android.view.View",description="",resource="";
  int id=4;boolean visible=true,enabled=true,clickable,scrollable;
  Rect bounds=new Rect(0,0,1080,1920);
  List<AccessibilityNodeInfo> children=new ArrayList<>();int declared=-1;
  CharSequence getPackageName(){return pkg;}CharSequence getText(){return text;}CharSequence getClassName(){return clazz;}
  CharSequence getContentDescription(){return description;}String getViewIdResourceName(){return resource;}
  int getWindowId(){return id;}boolean isVisibleToUser(){return visible;}boolean isEnabled(){return enabled;}
  boolean isClickable(){return clickable;}boolean isScrollable(){return scrollable;}
  void getBoundsInScreen(Rect r){r.set(bounds);}int getChildCount(){return declared>=0?declared:children.size();}
  AccessibilityNodeInfo getChild(int i){return i<children.size()?children.get(i):null;}
  void recycle(){if(tapped&&scenario.equals("late-complete")&&id==5&&bounds.top==0&&bounds.bottom==1920&&postReadyReads>=2)time=100000;}
 }
 static class AccessibilityWindowInfo {
  static final int TYPE_APPLICATION=1;
  int id=4,type=1;boolean active=true,focused=true;
  Rect bounds=new Rect(0,0,1080,1920);
  boolean isActive(){return active;}boolean isFocused(){return focused;}int getType(){return type;}int getId(){return id;}
  void getBoundsInScreen(Rect r){r.set(bounds);}void recycle(){}
 }
 static AccessibilityNodeInfo node(int id,String text,Rect bounds){AccessibilityNodeInfo n=new AccessibilityNodeInfo();n.id=id;n.text=text;n.bounds=bounds;return n;}
'''+"\n".join(factory)+r'''
 static AccessibilityNodeInfo find(AccessibilityNodeInfo root,String resource){if(root.resource.equals(resource))return root;for(AccessibilityNodeInfo n:root.children){AccessibilityNodeInfo found=find(n,resource);if(found!=null)return found;}return null;}
 static void detach(AccessibilityNodeInfo root,AccessibilityNodeInfo target){if(root.children.remove(target))return;for(AccessibilityNodeInfo n:root.children)detach(n,target);}
 static AccessibilityNodeInfo firstScrollable(AccessibilityNodeInfo root){if(root.scrollable)return root;for(AccessibilityNodeInfo n:root.children){AccessibilityNodeInfo found=firstScrollable(n);if(found!=null)return found;}return null;}
 static String scalar(Object object,String field){try{java.lang.reflect.Field f=object.getClass().getDeclaredField(field);f.setAccessible(true);return String.valueOf(f.get(object));}catch(ReflectiveOperationException unavailable){return "missing";}}
 static AccessibilityNodeInfo observedBody(int id){
  AccessibilityNodeInfo root=capturedBody(id),outer=find(root,"com.android.settings:id/content_parent"),inner=find(root,"com.android.settings:id/recycler_view"),header=find(root,"com.android.settings:id/collapsing_toolbar");
  if(scenario.equals("r3-wrong-outer-class"))outer.clazz="android.widget.FrameLayout";
  if(scenario.equals("r3-wrong-outer-resource"))outer.resource="com.android.settings:id/unrelated";
  if(scenario.equals("r3-wrong-inner-class"))inner.clazz="android.widget.ScrollView";
  if(scenario.equals("r3-wrong-inner-resource"))inner.resource="com.android.settings:id/unrelated";
  if(scenario.equals("r3-sibling-inner")){detach(root,inner);root.children.add(inner);}
  if(scenario.equals("r3-sibling-header")){detach(root,header);root.children.add(header);}
  if(scenario.equals("r3-third-scroll")){AccessibilityNodeInfo third=node(id,"",new Rect(0,800,900,1700));third.scrollable=true;root.children.add(third);}
  if(scenario.equals("r3-missing-inner"))detach(root,inner);
  if(scenario.equals("r3-disabled-outer"))outer.enabled=false;
  if(scenario.equals("r3-hidden-inner"))inner.visible=false;
  if(scenario.equals("r3-clipped-outer"))outer.bounds=new Rect(-1,63,1080,1857);
  if(scenario.equals("r3-inner-outside-outer"))inner.bounds=new Rect(0,1,1080,1857);
  if(scenario.equals("r3-header-overlap"))header.bounds=new Rect(0,63,1080,600);
  if(scenario.equals("r3-wrong-title"))header.description="Apps now";
  if(scenario.equals("r3-mixed-title"))header.text="Apps";
  if(scenario.equals("r3-wrong-title-class"))header.clazz="android.widget.TextView";
  if(scenario.equals("r3-wrong-title-resource"))header.resource="android:id/title";
  if(scenario.equals("r3-duplicate-title")){AccessibilityNodeInfo other=node(id,"",new Rect(0,63,1080,533));other.clazz=header.clazz;other.description=header.description;other.resource=header.resource;root.children.add(other);}
  if(scenario.equals("r3-title-child")){AccessibilityNodeInfo label=node(id,"Apps",new Rect(30,200,800,380));label.clazz="android.widget.TextView";header.children.add(label);}
  if(scenario.equals("r3-foreign-inner"))inner.pkg="foreign.package";
  if(scenario.equals("r3-incomplete"))inner.declared=inner.children.size()+1;
  return root;
 }
 static AccessibilityNodeInfo body(int id){
  if(tapped&&scenario.startsWith("r3-"))return observedBody(id);
  AccessibilityNodeInfo root=node(id,"",new Rect(0,0,1080,1920));
  AccessibilityNodeInfo header=node(id,"",new Rect(30,200,800,380));header.clazz="android.widget.FrameLayout";header.description="Apps";header.resource="com.android.settings:id/collapsing_toolbar";
  AccessibilityNodeInfo scroll=node(id,"",new Rect(0,500,1080,1850));scroll.scrollable=true;
  root.children.add(header);root.children.add(scroll);
  if(!tapped)return root;
  if(scenario.equals("foreign-node"))scroll.pkg="foreign.package";
  if(scenario.equals("wrong-child-window"))scroll.id=99;
  if(scenario.equals("invalid-geometry"))scroll.bounds=new Rect(1,2,1,4);
  if(scenario.equals("clipped-candidate"))scroll.bounds=new Rect(0,500,1080,1921);
  if(scenario.equals("disabled"))scroll.enabled=false;
  if(scenario.equals("hidden"))scroll.visible=false;
  if(scenario.equals("ambiguous-scroll")){AccessibilityNodeInfo other=node(id,"",new Rect(10,600,1000,1800));other.scrollable=true;root.children.add(other);}
  if(scenario.equals("duplicate"))root.children.add(scroll);
  if(scenario.equals("cycle"))scroll.children.add(root);
  if(scenario.equals("incomplete-after-scroll")){AccessibilityNodeInfo missing=node(id,"",new Rect(0,500,400,700));missing.declared=1;root.children.add(1,missing);}
  if(scenario.equals("child-budget"))scroll.declared=129;
  if(scenario.equals("node-budget"))for(int i=0;i<128;i++){AccessibilityNodeInfo a=node(id,"",new Rect(1,1,2,2));scroll.children.add(a);for(int j=0;j<4;j++)a.children.add(node(id,"",new Rect(1,1,2,2)));}
  if(scenario.equals("depth-budget")){AccessibilityNodeInfo a=scroll;for(int i=0;i<67;i++){AccessibilityNodeInfo b=node(id,"",new Rect(1,1,2,2));a.children.add(b);a=b;}}
  if(scenario.equals("header-missing"))header.text="Settings";
  if(scenario.equals("special-access")||scenario.equals("nonactionable-label")){
   scroll.scrollable=false;AccessibilityNodeInfo row=node(id,"",new Rect(0,700,1080,900));row.clickable=scenario.equals("special-access");
   row.children.add(node(id,"Special app access",new Rect(40,740,800,820)));root.children.add(row);
  }
  return root;
 }
 static class FakeAutomation {
  int refreshes;AccessibilityNodeInfo current;
  boolean clearCache(){refreshes++;return !scenario.equals("cache-failed");}
  List<AccessibilityWindowInfo> getWindows(){
   AccessibilityWindowInfo w=new AccessibilityWindowInfo();
   // Actual R2: Apps tap0, target query+63ms, START+76ms, display+1462ms,
   // missing scroll result+1814ms. Complete AX at+1900ms is a synthetic continuation.
   boolean old=tapped&&(scenario.equals("old-window")||(scenario.equals("actual-timeline")&&time<10076));
   w.id=!tapped||old?4:5;current=body(w.id);
   if(tapped&&scenario.equals("actual-timeline")&&time>=10076&&time<11900)current=null;
   if(tapped&&scenario.equals("null-root"))current=null;
   if(tapped&&scenario.equals("foreign-window"))current.pkg="foreign.package";
   if(tapped&&scenario.equals("window-geometry"))w.bounds=new Rect(-1,0,1080,1920);
   if(tapped&&scenario.equals("root-geometry"))current.bounds=new Rect(0,0,1081,1920);
   if(tapped&&scenario.equals("not-focused"))w.focused=false;
   if(tapped&&(scenario.equals("ambiguous-window")||scenario.equals("r3-ambiguous-window"))){AccessibilityWindowInfo other=new AccessibilityWindowInfo();other.id=6;return List.of(w,other);}
   if(tapped&&scenario.equals("window-list-incomplete"))return Arrays.asList(w,null);
   if(tapped&&scenario.equals("deadline"))time=100000;
   if(tapped&&scenario.equals("regressed-clock"))time=1;
   if(tapped&&current!=null&&w.id==5)postReadyReads++;
   return List.of(w);
  }
  AccessibilityNodeInfo getRootInActiveWindow(){return current;}
 }
 static class FakeInstrumentation {final FakeAutomation a=new FakeAutomation();FakeAutomation getUiAutomation(){return a;}}
 static class FakeDevice {int getDisplayWidth(){return 1080;}int getDisplayHeight(){return 1920;}}
 static int postReadyReads;
 static void assertTrue(String message,boolean value){if(!value)throw new AssertionError(message);}
 static void assertEquals(String message,int expected,int value){if(expected!=value)throw new AssertionError(message);}
'''+"\n".join(classes)+methods+r'''
 public static void main(String[] args){
  scenario=args[0];AppsProbe p=new AppsProbe();
  if(scenario.startsWith("snapshot:")){
   scenario=scenario.substring(9);tapped=true;time=12000;
   AppsWindowSnapshot snapshot=p.readInitialOfferAppsWindow(100000,true);
   System.out.println("SNAPSHOT_STATUS="+snapshot.status+";reason="+scalar(snapshot,"failureReason")+";active="+scalar(snapshot,"activeWindows")+";headers="+scalar(snapshot,"headers")+";scrolls="+scalar(snapshot,"scrolls"));return;
  }
  p.captureInitialOfferPreAppsWindow();
  tapped=true;time=10063;p.actions.add("Clicked exact visible system Settings control: Apps");
  try{p.awaitInitialOfferAppsWindow();}catch(AssertionError failure){System.err.println("SCROLL_INPUTS=0;actions="+p.actions.size());throw failure;}
  System.out.println("ACQUISITION_RETURNED");
  assertTrue("unchanged single UI_WAIT budget",p.appsWindowGate.deadline-p.appsWindowGate.startedAt==UI_WAIT_MS);
  assertTrue("different post window",p.appsWindowGate.pre.windowId!=p.appsWindowGate.ready.windowId);
  assertEquals("two complete samples",2,p.appsWindowGate.stableSamples);
  assertEquals("one public refresh per poll",p.appsWindowGate.polls,p.instrumentation.a.refreshes);
  assertEquals("read-only pre acquisition",0,p.appsPreActionDelta);
  assertEquals("read-only post acquisition",0,p.appsPostActionDelta);
  assertEquals("exact Apps navigation",1,p.appsTapActionDelta);
  assertTrue("bounded deadline",p.appsWindowGate.readyAt<p.appsWindowGate.deadline);
  if(scenario.equals("actual-timeline"))assertTrue("waited past incomplete AX result",p.appsWindowGate.readyAt>=12000);
  if(scenario.equals("special-access"))assertTrue("real actionable target",p.appsWindowGate.ready.kind.equals("special-access"));
  if(scenario.equals("r3-captured")||scenario.equals("r3-title-child")){
   assertTrue("unchanged first scroll match",p.appsWindowGate.ready.candidate.equals(firstScrollable(p.instrumentation.a.current).bounds));
   assertTrue("exact outer raw bounds",p.appsWindowGate.ready.candidate.equals(new Rect(0,63,1080,1857)));
  }
  System.out.println("PASS;SCROLL_INPUTS=0;polls="+p.appsWindowGate.polls+";readyAt="+p.appsWindowGate.readyAt);
 }
}
'''
        path = cls.directory / "AppsProbe.java"; path.write_text(probe)
        p = subprocess.run([javac, "-d", str(cls.directory), str(path)], capture_output=True, text=True, timeout=60)
        if p.returncode:
            raise AssertionError(p.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def probe(self, scenario):
        return subprocess.run([self.java, "-cp", str(self.directory), "AppsProbe", scenario], capture_output=True, text=True, timeout=15)

    def test_actual_r2_transition_timeline_waits_without_scroll_or_deadline_increase(self):
        result = self.probe("actual-timeline")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SCROLL_INPUTS=0", result.stdout)

    def test_complete_unique_actionable_special_access_can_replace_scroll_readiness(self):
        result = self.probe("special-access")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_captured_r3_owned_nested_body_and_logical_title_are_ready(self):
        self.assertEqual(self.captured_node_count, 47)
        for scenario in ("r3-captured", "r3-title-child"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("PASS;SCROLL_INPUTS=0", result.stdout)

    def test_captured_r3_topology_variants_fail_before_acquisition_returns(self):
        self.assertEqual(self.probe("r3-captured").returncode, 0)
        for scenario in ("r3-wrong-outer-class", "r3-wrong-outer-resource", "r3-wrong-inner-class",
                         "r3-wrong-inner-resource", "r3-sibling-inner", "r3-sibling-header", "r3-third-scroll",
                         "r3-missing-inner", "r3-disabled-outer", "r3-hidden-inner", "r3-clipped-outer",
                         "r3-inner-outside-outer", "r3-header-overlap", "r3-wrong-title", "r3-mixed-title",
                         "r3-wrong-title-class", "r3-wrong-title-resource", "r3-duplicate-title",
                         "r3-foreign-inner", "r3-incomplete", "r3-ambiguous-window"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("ACQUISITION_RETURNED", result.stdout)
                self.assertIn("SCROLL_INPUTS=0;actions=1", result.stderr)

    def test_failed_snapshot_distinguishes_active_window_and_topology_ambiguity(self):
        topology = self.probe("snapshot:r3-wrong-outer-class")
        self.assertIn("SNAPSHOT_STATUS=ambiguous;reason=scroll-topology;active=1;headers=1;scrolls=2", topology.stdout)
        windows = self.probe("snapshot:r3-ambiguous-window")
        self.assertIn("SNAPSHOT_STATUS=ambiguous;reason=active-windows;active=2", windows.stdout)

    def test_strict_window_and_complete_dfs_guards_refuse_before_any_scroll(self):
        self.assertEqual(self.probe("actual-timeline").returncode, 0)
        for scenario in ("foreign-node", "foreign-window", "ambiguous-window", "ambiguous-scroll",
                         "invalid-geometry", "window-geometry", "root-geometry", "clipped-candidate",
                         "disabled", "hidden", "duplicate", "cycle", "incomplete-after-scroll",
                         "wrong-child-window", "child-budget", "node-budget", "depth-budget",
                         "header-missing", "nonactionable-label", "window-list-incomplete", "not-focused"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                self.assertIn("SCROLL_INPUTS=0;actions=1", result.stderr)
                self.assertNotIn("ACQUISITION_RETURNED", result.stdout)

    def test_snapshot_classification_requires_entire_valid_owned_tree(self):
        expected = {
            "foreign-node": "foreign", "foreign-window": "foreign",
            "ambiguous-window": "ambiguous", "ambiguous-scroll": "ambiguous",
            "invalid-geometry": "geometry", "window-geometry": "geometry", "root-geometry": "geometry",
            "incomplete-after-scroll": "incomplete", "window-list-incomplete": "incomplete",
            "wrong-child-window": "incomplete", "not-focused": "incomplete",
            "duplicate": "duplicate", "cycle": "duplicate",
            "child-budget": "budget", "node-budget": "budget", "depth-budget": "budget",
            "clipped-candidate": "body-missing", "disabled": "body-missing", "hidden": "body-missing",
            "header-missing": "body-missing", "nonactionable-label": "body-missing",
        }
        self.assertIn("SNAPSHOT_STATUS=ready", self.probe("snapshot:valid").stdout)
        for scenario, status in expected.items():
            with self.subTest(scenario=scenario):
                result = self.probe("snapshot:" + scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("SNAPSHOT_STATUS=" + status, result.stdout)

    def test_old_window_null_timeout_late_and_regressed_clock_never_authorize_scroll(self):
        self.assertEqual(self.probe("actual-timeline").returncode, 0)
        for scenario in ("old-window", "null-root", "deadline", "late-complete", "regressed-clock", "cache-failed"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                self.assertNotIn("ACQUISITION_RETURNED", result.stdout)


class InitialOfferR4ObserverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="ota88-r4-observers-")
        cls.directory = Path(cls.temporary.name)
        home = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
        javac = str(Path(home) / "bin/javac") if (Path(home) / "bin/javac").is_file() else shutil.which("javac")
        assert javac is not None
        cls.java = str(Path(javac).with_name("java"))
        source = JAVA.read_text()
        classes = []
        for name in ("AppsWindowSnapshot", "AppsWindowGate", "InitialOfferObservation"):
            marker = "    private static final class " + name
            if marker not in source:
                continue
            start = source.index(marker); end = source.index("{", start) + 1; depth = 1
            while depth:
                depth += (source[end] == "{") - (source[end] == "}"); end += 1
            classes.append(source[start:end])
        methods = java_method(source, "initialOfferAppsClock") + java_method(source, "scrollUntilVisibleSystemText")
        if "private void awaitInitialOfferInstallerSuccess(" in source:
            methods += "\n".join(java_method(source, name) for name in (
                "initialOfferDescendant", "initialOfferActionableRow", "collectInitialOfferObservation",
                "readInitialOfferObservation", "awaitInitialOfferObservation",
                "awaitInitialOfferInstallerSuccess", "awaitInitialOfferCleanupTarget"))
            methods += "\n String observedStatus(int phase){return readInitialOfferObservation(phase,100000).status;}\n"
        else:
            methods += '''
 void awaitInitialOfferInstallerSuccess(String owner){throw new AssertionError("observer absent");}
 void awaitInitialOfferCleanupTarget(){throw new AssertionError("observer absent");}
 String observedStatus(int phase){return "observer-absent";}
'''
        confirmation = java_method(source, "confirmSystemInstaller")
        end = confirmation.index("        installerSuccessObserved = true;")
        marker = "        if (isPublic88To96OfferMode()) {"
        start = confirmation.index(marker, confirmation.index("systemUpdateSelections++")) if "awaitInitialOfferInstallerSuccess(installerPackage);" in confirmation else confirmation.index("        UiObject2 success = waitFor(")
        methods += "\n void exerciseSuccessRegion(String installerPackage){\n" + confirmation[start:end] + "\n }\n"
        cleanup = java_method(source, "cleanupUnknownSourcePermissionThroughVisibleSettings")
        anchor = 'scrollUntilVisibleSystemText("Install unknown apps", Direction.DOWN).click();\n        device.waitForIdle(750);'
        start = cleanup.index(anchor) + len(anchor)
        end = cleanup.index('        waitFor(By.text("Allow from this source")', start)
        methods += "\n void exerciseCleanupRegion(){\n" + cleanup[start:end] + "\n }\n"
        factories = []
        for xml, method in ((CAPTURED_INSTALL_SUCCESS_XML, "installerBody"), (CAPTURED_CLEANUP_TARGET_XML, "cleanupBody")):
            root = ET.fromstring(xml); nodes = list(root.iter("node"))
            factories.append(" static AccessibilityNodeInfo " + method + "(int id){")
            for index, node in enumerate(nodes):
                rect = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", node.get("bounds", "")); assert rect
                factories.append(f'  AccessibilityNodeInfo n{index}=new AccessibilityNodeInfo();n{index}.id=id;n{index}.bounds=new Rect({",".join(rect.groups())});')
                for field, attribute in (("pkg", "package"), ("text", "text"), ("clazz", "class"), ("description", "content-desc"), ("resource", "resource-id")):
                    factories.append(f'  n{index}.{field}={json.dumps(node.get(attribute, ""))};')
                for field, attribute in (("visible", "visible-to-user"), ("enabled", "enabled"), ("clickable", "clickable"), ("scrollable", "scrollable")):
                    factories.append(f'  n{index}.{field}={node.get(attribute, "false")};')
            for parent in nodes:
                for child in parent:
                    factories.append(f'  n{nodes.index(parent)}.children.add(n{nodes.index(child)});')
            factories.append("  n0.root=true;return n0;\n }")
        probe = r'''
import java.util.*;
public final class ObserverProbe {
 static final long UI_WAIT_MS=90000,SHORT_WAIT_MS=20000;
 static long time=10000;static String scenario;static int phase,inputs,getters,lookups,scrollQueries,readyReads;static ObserverProbe live;
 final FakeInstrumentation instrumentation=new FakeInstrumentation();final FakeDevice device=new FakeDevice();
 final List<String> actions=new ArrayList<>();AppsWindowGate appsWindowGate;
 static class OtaFlowPolicy {static final String SETTINGS_PACKAGE="com.android.settings";}
 static class Build {static class VERSION {static final int SDK_INT=36;}static class VERSION_CODES {static final int UPSIDE_DOWN_CAKE=34;}}
 static class SystemClock {static long uptimeMillis(){return time;}static void sleep(long ms){assertTrue("bounded conditional poll",ms>0&&ms<=100);time+=ms;}}
 static class Rect {
  int left,top,right,bottom;Rect(){}Rect(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}
  void set(Rect r){left=r.left;top=r.top;right=r.right;bottom=r.bottom;}boolean isEmpty(){return left>=right||top>=bottom;}
  boolean contains(Rect r){return !r.isEmpty()&&left<=r.left&&top<=r.top&&right>=r.right&&bottom>=r.bottom;}
  public boolean equals(Object o){if(!(o instanceof Rect))return false;Rect r=(Rect)o;return left==r.left&&top==r.top&&right==r.right&&bottom==r.bottom;}
 }
 static class AccessibilityNodeInfo {
  String pkg="",text="",clazz="android.view.View",description="",resource="";int id=5,declared=-1;
  boolean visible=true,enabled=true,clickable,scrollable,root;Rect bounds=new Rect(0,0,1080,1920);List<AccessibilityNodeInfo> children=new ArrayList<>();
  CharSequence getPackageName(){return pkg;}CharSequence getText(){return text;}CharSequence getClassName(){return clazz;}
  CharSequence getContentDescription(){return description;}String getViewIdResourceName(){return resource;}int getWindowId(){return id;}
  boolean isVisibleToUser(){return visible;}boolean isEnabled(){return enabled;}boolean isClickable(){return clickable;}boolean isScrollable(){return scrollable;}
  void getBoundsInScreen(Rect r){r.set(bounds);}int getChildCount(){return declared>=0?declared:children.size();}AccessibilityNodeInfo getChild(int i){return i<children.size()?children.get(i):null;}
  void recycle(){if(root&&scenario.endsWith("late")&&readyReads>=2)time=phase==1?100000:90000;}
 }
 static class AccessibilityWindowInfo {
  static final int TYPE_APPLICATION=1;int id=5,type=1;boolean active=true,focused=true;Rect bounds=new Rect(0,0,1080,1920);
  int getId(){return id;}int getType(){return type;}boolean isActive(){return active;}boolean isFocused(){return focused;}void getBoundsInScreen(Rect r){r.set(bounds);}void recycle(){}
 }
'''+"\n".join(factories)+r'''
 static AccessibilityNodeInfo byText(AccessibilityNodeInfo root,String text){if(root==null)return null;if(root.text.equals(text))return root;for(AccessibilityNodeInfo n:root.children){AccessibilityNodeInfo r=byText(n,text);if(r!=null)return r;}return null;}
 static AccessibilityNodeInfo byResource(AccessibilityNodeInfo root,String res){if(root.resource.equals(res))return root;for(AccessibilityNodeInfo n:root.children){AccessibilityNodeInfo r=byResource(n,res);if(r!=null)return r;}return null;}
 static AccessibilityNodeInfo parent(AccessibilityNodeInfo root,AccessibilityNodeInfo child){if(root.children.contains(child))return root;for(AccessibilityNodeInfo n:root.children){AccessibilityNodeInfo p=parent(n,child);if(p!=null)return p;}return null;}
 static int scrolls(AccessibilityNodeInfo root){if(root==null)return 0;int count=root.scrollable?1:0;for(AccessibilityNodeInfo n:root.children)count+=scrolls(n);return count;}
 static AccessibilityNodeInfo observedBody(){
  AccessibilityNodeInfo r=phase==1?installerBody(5):cleanupBody(5);
  AccessibilityNodeInfo target=phase==1?byText(r,"App installed."):byText(r,"YAWF Stream");
  AccessibilityNodeInfo action=phase==1?byText(r,"Open"):byText(r,"Allowed");
  if(scenario.endsWith("foreign"))action.pkg="foreign.package";
  if(scenario.endsWith("wrong-namespace"))target.resource="com.google.android.packageinstaller:id/install_success";
  if(scenario.endsWith("missing-resource"))target.resource="";
  if(scenario.endsWith("wrong-label"))target.text+=" now";
  if(scenario.endsWith("wrong-title"))(phase==1?byText(r,"YAWF Stream"):byText(r,"Install unknown apps")).text="Different page";
  if(scenario.endsWith("missing-action"))action.text="Not allowed";
  if(scenario.endsWith("disabled"))action.enabled=false;
  if(scenario.endsWith("hidden"))action.visible=false;
  if(scenario.endsWith("clipped"))target.bounds.right=1081;
  if(scenario.endsWith("incomplete"))target.declared=1;
  if(scenario.endsWith("duplicate"))r.children.add(target);
  if(scenario.endsWith("duplicate-role")){AccessibilityNodeInfo other=phase==1?byText(installerBody(5),"Open"):byText(cleanupBody(5),"YAWF Stream");r.children.add(other);}
  if(scenario.endsWith("wrong-pair")){
   AccessibilityNodeInfo p=parent(r,action);p.children.remove(action);
   if(phase==1)r.children.add(action);else parent(r,byText(r,"Chrome")).children.add(action);
  }
  if(scenario.endsWith("depth-budget")){AccessibilityNodeInfo n=target;for(int i=0;i<66;i++){AccessibilityNodeInfo child=new AccessibilityNodeInfo();child.pkg=r.pkg;n.children.add(child);n=child;}}
  if(scenario.endsWith("child-budget"))target.declared=129;
  return r;
 }
 static class FakeAutomation {
  AccessibilityNodeInfo current;int refreshes;
  boolean clearCache(){refreshes++;return !scenario.endsWith("cache-failed");}
  List<AccessibilityWindowInfo> getWindows(){
   AccessibilityWindowInfo w=new AccessibilityWindowInfo();
   if(time<10200||scenario.endsWith("timeout")){current=new AccessibilityNodeInfo();current.pkg=phase==1?"com.google.android.packageinstaller":"com.android.settings";}
   else {current=observedBody();readyReads++;}
   if(scenario.endsWith("null-root"))current=null;
   if(scenario.endsWith("wrong-owner")&&current!=null)current.pkg="foreign.package";
   if(scenario.endsWith("window-geometry"))w.bounds=new Rect(-1,0,1080,1920);
   if(scenario.endsWith("not-focused"))w.focused=false;
   if(scenario.endsWith("input"))live.actions.add("unexpected input");
   if(scenario.endsWith("regress"))time=1;
   if(scenario.endsWith("multiple-windows")){AccessibilityWindowInfo second=new AccessibilityWindowInfo();second.id=6;return List.of(w,second);}
   return List.of(w);
  }
  AccessibilityNodeInfo getRootInActiveWindow(){return current;}
 }
 static class FakeInstrumentation {final FakeAutomation a=new FakeAutomation();FakeAutomation getUiAutomation(){return a;}}
 static class BySelector {String text;boolean scrollable;BySelector(String s){text=s;}BySelector pkg(String s){return this;}}
 static class By {static BySelector text(String s){return new BySelector(s);}static BySelector scrollable(boolean s){BySelector b=new BySelector(null);b.scrollable=s;return b;}}
 enum Direction {DOWN}
 static class StaleObjectException extends RuntimeException {}
 static class UiObject2 {
  final AccessibilityNodeInfo node;UiObject2(AccessibilityNodeInfo n){node=n;}boolean isEnabled(){return node==null||node.enabled;}
  String getResourceName(){getters++;throw new StaleObjectException();}
  void click(){inputs++;}void scroll(Direction d,float fraction){throw new AssertionError("forced scroll forbidden");}
 }
 static class FakeDevice {
  int getDisplayWidth(){return 1080;}int getDisplayHeight(){return 1920;}
  UiObject2 findObject(BySelector selector){live.instrumentation.a.getWindows();if(selector.scrollable){scrollQueries++;return null;}lookups++;AccessibilityNodeInfo n=byText(live.instrumentation.a.current,selector.text);return n==null?null:new UiObject2(n);}
  void waitForIdle(long ms){}
 }
 boolean isPublic88To96OfferMode(){return true;}
 void assertNoBindingTerms(){}
 UiObject2 waitFor(BySelector s,long timeout,String label){time=10200;instrumentation.a.getWindows();return new UiObject2(byText(instrumentation.a.current,s.text));}
 static void assertTrue(String label,boolean condition){if(!condition)throw new AssertionError(label);}
 static void assertNotNull(String label,Object value){assertTrue(label,value!=null);}
 static void assertEquals(String label,Object expected,Object value){assertTrue(label,Objects.equals(expected,value));}
 static void fail(String message){throw new AssertionError(message);}
'''+"\n".join(classes)+methods+r'''
 public static void main(String[] args){
  scenario=args[0];boolean snapshot=scenario.startsWith("snapshot:");if(snapshot)scenario=scenario.substring(9);
  phase=scenario.startsWith("success")?1:2;ObserverProbe p=new ObserverProbe();live=p;
  p.appsWindowGate=new AppsWindowGate(0);p.appsWindowGate.ready=new AppsWindowSnapshot();p.appsWindowGate.ready.windowId=5;
  if(scenario.endsWith("expired"))time=90000;
  if(snapshot){time=10500;System.out.println("SNAPSHOT="+p.observedStatus(phase));return;}
  try {
   if(phase==1)p.exerciseSuccessRegion("com.google.android.packageinstaller");else p.exerciseCleanupRegion();
  }catch(Throwable failure){System.err.println("REFUSED;inputs="+inputs+";getters="+getters+";scrollQueries="+scrollQueries);throw failure;}
  System.out.println("OBSERVER_RETURNED");
  assertEquals("no retained success getter",0,getters);
  assertEquals("exact normal input count",phase==1?0:1,inputs);
  assertEquals("no forced scroll queries",0,scrollQueries);
  if(phase==2){assertEquals("one unchanged target lookup",1,lookups);assertEquals("captured page fits without scrolling",0,scrolls(p.instrumentation.a.current));assertTrue("shared cleanup deadline",time<90000);}
  assertTrue("two fresh ready samples",readyReads>=2);
  System.out.println("PASS;inputs="+inputs+";getters="+getters+";refreshes="+p.instrumentation.a.refreshes+";time="+time);
 }
}
'''
        path = cls.directory / "ObserverProbe.java"; path.write_text(probe)
        p = subprocess.run([javac, "-d", str(cls.directory), str(path)], capture_output=True, text=True, timeout=60)
        if p.returncode:
            raise AssertionError(p.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def probe(self, scenario):
        return subprocess.run([self.java, "-cp", str(self.directory), "ObserverProbe", scenario], capture_output=True, text=True, timeout=20)

    def test_r4_installer_capture_succeeds_without_the_actual_stale_postgetter(self):
        self.assertEqual(len(list(ET.fromstring(CAPTURED_INSTALL_SUCCESS_XML).iter("node"))), 16)
        result = self.probe("success-valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS;inputs=0;getters=0", result.stdout)

    def test_r4_visible_non_scrollable_cleanup_target_waits_before_unchanged_lookup(self):
        self.assertEqual(len(list(ET.fromstring(CAPTURED_CLEANUP_TARGET_XML).iter("node"))), 32)
        result = self.probe("cleanup-valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS;inputs=1;getters=0", result.stdout)

    def test_observers_refuse_wrong_namespace_missing_resource_and_cross_owner_pairings(self):
        self.assertEqual(self.probe("success-valid").returncode, 0)
        self.assertEqual(self.probe("cleanup-valid").returncode, 0)
        for scenario in ("success-wrong-namespace", "success-missing-resource", "success-foreign", "success-wrong-title",
                         "success-wrong-label", "success-missing-action", "success-wrong-pair", "success-duplicate-role",
                         "cleanup-wrong-title", "cleanup-wrong-label", "cleanup-missing-action", "cleanup-wrong-pair", "cleanup-duplicate-role"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("OBSERVER_RETURNED", result.stdout)
                self.assertIn("REFUSED;inputs=0;getters=0", result.stderr)

    def test_observers_refuse_partial_foreign_or_invalid_raw_snapshots(self):
        self.assertEqual(self.probe("cleanup-valid").returncode, 0)
        for phase in ("success", "cleanup"):
            for suffix in ("null-root", "wrong-owner", "multiple-windows", "not-focused", "disabled", "hidden",
                           "clipped", "incomplete", "duplicate", "window-geometry", "depth-budget", "child-budget"):
                with self.subTest(phase=phase, suffix=suffix):
                    result = self.probe(phase + "-" + suffix)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("OBSERVER_RETURNED", result.stdout)
                    self.assertIn("REFUSED;inputs=0;getters=0", result.stderr)

    def test_observers_keep_deadlines_two_samples_and_input_free_acquisition(self):
        self.assertEqual(self.probe("success-valid").returncode, 0)
        for scenario in ("success-timeout", "success-late", "success-regress", "success-cache-failed", "success-input",
                         "cleanup-expired", "cleanup-timeout", "cleanup-late", "cleanup-regress", "cleanup-input"):
            with self.subTest(scenario=scenario):
                result = self.probe(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("OBSERVER_RETURNED", result.stdout)
                self.assertIn("REFUSED;inputs=0;getters=0", result.stderr)


if __name__ == "__main__":
    unittest.main()
