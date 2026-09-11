$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public static class WireframeWinTrust {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string path;
        public IntPtr file;
        public IntPtr knownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData {
        public uint cbStruct;
        public IntPtr policyCallbackData;
        public IntPtr sipClientData;
        public uint uiChoice;
        public uint revocationChecks;
        public uint unionChoice;
        public IntPtr fileInfo;
        public uint stateAction;
        public IntPtr stateData;
        public IntPtr urlReference;
        public uint providerFlags;
        public uint uiContext;
        public IntPtr signatureSettings;
    }

    // Only this documented prefix is needed; the remaining provider fields are not read.
    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderCertificate {
        public uint cbStruct;
        public IntPtr certificate;
    }

    public sealed class Result {
        public string Status;
        public byte[] Certificate;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint index, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterIndex);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint index);

    public static Result Verify(string path, IntPtr handle) {
        var file = new FileInfo { cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)), path = path, file = handle };
        IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        Marshal.StructureToPtr(file, filePointer, false);
        var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        var data = new TrustData {
            cbStruct = (uint)Marshal.SizeOf(typeof(TrustData)), uiChoice = 2,
            unionChoice = 1, fileInfo = filePointer, stateAction = 1,
            providerFlags = 0x1000, uiContext = 1
        };
        try {
            uint status = unchecked((uint)WinVerifyTrust(new IntPtr(-1), ref action, ref data));
            var result = new Result { Status = "0x" + status.ToString("X8") };
            IntPtr provider = WTHelperProvDataFromStateData(data.stateData);
            IntPtr signer = provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            IntPtr info = signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer, 0);
            if (info != IntPtr.Zero) {
                var certificate = (ProviderCertificate)Marshal.PtrToStructure(info, typeof(ProviderCertificate));
                if (certificate.certificate != IntPtr.Zero) {
                    using (var x509 = new X509Certificate2(certificate.certificate)) result.Certificate = x509.RawData;
                }
            }
            return result;
        } finally {
            data.stateAction = 2;
            WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            Marshal.DestroyStructure(filePointer, typeof(FileInfo));
            Marshal.FreeHGlobal(filePointer);
        }
    }
}
'@

    $path = [System.IO.Path]::GetFullPath($env:WIREFRAME_SIGNATURE_FILE)
    # Hold a read-only handle without write/delete sharing across the hash and signature checks.
    $file = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        if ($env:WIREFRAME_SIGNATURE_SIZE -and $file.Length -ne [long]$env:WIREFRAME_SIGNATURE_SIZE) {
            throw 'Installer size does not match the signed manifest'
        }
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $sha256 = [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '').ToLowerInvariant() }
        finally { $hash.Dispose() }
        if ($env:WIREFRAME_SIGNATURE_SHA256 -and $sha256 -cne $env:WIREFRAME_SIGNATURE_SHA256) {
            throw 'Installer SHA256 does not match the signed manifest'
        }
        $file.Position = 0
        $result = [WireframeWinTrust]::Verify($path, $file.SafeFileHandle.DangerousGetHandle())
        $certificate = if ($result.Certificate) { [Convert]::ToBase64String($result.Certificate) } else { $null }
        [ordered]@{ path = $path; size = $file.Length; sha256 = $sha256; winTrustStatus = $result.Status; certificate = $certificate } | ConvertTo-Json -Compress
    } finally { $file.Dispose() }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
