// Add-only companion to bootstrap-catalog-keychain.mjs. No value arguments,
// arbitrary accounts/keychains, ACL updates, unlocks, or network operations.
import Foundation
import Security

let account = "goose.gifts"
let allowed = Set([
    "goose.gifts.AMAZON_CREATORS_CREDENTIAL_ID",
    "goose.gifts.AMAZON_CREATORS_CREDENTIAL_SECRET",
    "goose.gifts.OPENAI_API_KEY",
    "goose.gifts.STAGING_AUTH_SECRET",
    "goose.gifts.CONTENT_ADMIN_ACCESS",
])
var created: [String] = []
func finish(_ error: String = "none") -> Never {
    let result: [String: Any] = ["status": error == "none" ? "created" : "requires_review", "created": created, "errorCode": error]
    if let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes)
    }
    exit(error == "none" ? 0 : 1)
}
func exact(_ value: [String: Any], _ keys: Set<String>) -> Bool { Set(value.keys) == keys }
guard CommandLine.arguments.count == 1 else { finish("keychain_arguments") }
var data = Data()
do {
    while let chunk = try FileHandle.standardInput.read(upToCount: 32769 - data.count), !chunk.isEmpty {
        data.append(chunk)
        if data.count > 32768 { finish("keychain_input") }
    }
} catch { finish("keychain_input") }
guard let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      exact(payload, ["schemaVersion", "entries"]),
      let version = payload["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
      let entries = payload["entries"] as? [[String: Any]], !entries.isEmpty, entries.count <= 4 else { finish("keychain_input") }
var values: [(String, Data)] = []
for entry in entries {
    guard exact(entry, ["service", "value"]), let service = entry["service"] as? String, allowed.contains(service),
          !values.contains(where: { $0.0 == service }), let value = entry["value"] as? String,
          !value.isEmpty, value.utf8.count <= 4096, value.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }),
          !["[encrypted]", "[sensitive]"].contains(value.lowercased()) else { finish("keychain_input") }
    values.append((service, Data(value.utf8)))
}
// Optional UI is disabled, not bypassed. A locked keychain or any need for
// interaction fails closed; no unlock, prompt automation or ACL repair occurs.
guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { finish("keychain_interaction") }
var keychain: SecKeychain?
guard SecKeychainCopyDefault(&keychain) == errSecSuccess, let keychain else { finish("keychain_default") }
var keychainStatus: SecKeychainStatus = 0
guard SecKeychainGetStatus(keychain, &keychainStatus) == errSecSuccess,
      keychainStatus & UInt32(kSecUnlockStateStatus) != 0 else { finish("keychain_locked") }
// Check the entire requested subset before adding anything. Even an identical
// item that appeared since the parent inspection is a race, never an update.
for (service, _) in values {
    let status = service.withCString { serviceBytes in account.withCString { accountBytes in
        SecKeychainFindGenericPassword(keychain, UInt32(service.utf8.count), serviceBytes,
                                      UInt32(account.utf8.count), accountBytes, nil, nil, nil)
    } }
    guard status == errSecItemNotFound else { finish(status == errSecSuccess ? "keychain_duplicate" : "keychain_lookup") }
}
var trusted: SecTrustedApplication?
guard SecTrustedApplicationCreateFromPath("/usr/bin/security", &trusted) == errSecSuccess, let trusted else { finish("keychain_trusted_reader") }
for (service, value) in values {
    var access: SecAccess?
    guard SecAccessCreate(service as CFString, [trusted] as CFArray, &access) == errSecSuccess, let access else { finish("keychain_access") }
    let attributes: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
        kSecAttrAccount: account, kSecAttrLabel: service, kSecValueData: value,
        kSecUseKeychain: keychain, kSecAttrAccess: access]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { finish(status == errSecDuplicateItem ? "keychain_duplicate" : "keychain_add") }
    created.append(service)
}
finish()
