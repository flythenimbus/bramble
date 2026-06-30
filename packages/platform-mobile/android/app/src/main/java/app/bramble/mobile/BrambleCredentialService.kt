package app.bramble.mobile

import android.os.Build
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest

// Bramble's passkey provider for the Android Credential Manager (API 34+). The system pulls
// at request time: onBeginGet returns the passkeys we hold for the request (each as an entry
// backed by a PendingIntent into an unlock+sign Activity), and onBeginCreate offers a "save to
// Bramble" entry whose PendingIntent mints + persists. The heavy work (unlock, native crypto)
// runs in those Activities, not here - mirroring BrambleAutofillService. Passwords stay on the
// classic AutofillService; this handles passkeys only.
//
// SKELETON (step 1): registers the provider so it appears in Settings and the system binds it,
// but offers nothing yet. Assertion (step 2) and registration (step 3) fill these in.
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class BrambleCredentialService : CredentialProviderService() {

    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        // No passkey entries yet (step 2 reads the vault + returns PublicKeyCredentialEntry list).
        callback.onResult(BeginGetCredentialResponse())
    }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        // No "save to Bramble" entry yet (step 3 returns a CreateEntry + PendingIntent).
        callback.onResult(BeginCreateCredentialResponse())
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        // Nothing cached outside the vault to clear.
        callback.onResult(null)
    }
}
