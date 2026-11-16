using System.Security.Cryptography;
using System.Text.Json;

namespace ExamGuard.Agent;

/// <summary>Stores the short-lived credential encrypted to the current Windows user.</summary>
public sealed class CredentialStore(string path)
{
    public Credential? Load()
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<Credential>(plain);
        }
        catch (Exception error) when (error is CryptographicException or JsonException)
        {
            Clear();
            return null;
        }
    }

    public void Save(Credential credential)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var plain = JsonSerializer.SerializeToUtf8Bytes(credential);
        File.WriteAllBytes(path, ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser));
    }

    public void Clear() => File.Delete(path);
}
