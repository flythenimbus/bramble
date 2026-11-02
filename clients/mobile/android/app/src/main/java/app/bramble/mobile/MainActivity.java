package app.bramble.mobile;

import android.os.Bundle;

import androidx.activity.EdgeToEdge;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutofillBridgePlugin.class);
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(NativeCryptoPlugin.class);
        registerPlugin(NativeHttpPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw under the system bars below Android 15 too, as 15+ forces; mobile.css pads (#173).
        // After super: touching the window decor any earlier builds it with an action bar.
        EdgeToEdge.enable(this);
    }
}
