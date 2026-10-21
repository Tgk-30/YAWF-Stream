package com.yawf.permissionreturnfixture

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

class FixtureActivity : Activity() {
  private lateinit var androidUpdater: YawfAndroidUpdater

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(
      TextView(this).apply {
        gravity = Gravity.CENTER
        text = "Permission return lifecycle fixture"
      },
    )
    androidUpdater = YawfAndroidUpdater.attach(this)
  }

  override fun onResume() {
    super.onResume()
    val returningFromUnknownSourceSettings =
      getSharedPreferences(FixturePolicy.PREFERENCES_NAME, MODE_PRIVATE)
        .getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)
    if (
      ::androidUpdater.isInitialized &&
      !(BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME && returningFromUnknownSourceSettings)
    ) {
      androidUpdater.onResume()
    }
  }

  override fun onPause() {
    if (::androidUpdater.isInitialized) androidUpdater.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::androidUpdater.isInitialized) androidUpdater.onWindowFocusChanged(hasFocus)
  }

  override fun onDestroy() {
    if (::androidUpdater.isInitialized) androidUpdater.onDestroy()
    super.onDestroy()
  }
}
