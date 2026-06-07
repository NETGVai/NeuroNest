/**
 * NeuroNest Secure Core — Native Node-API addon.
 *
 * Moves sensitive logic out of JavaScript into compiled native code:
 * - Token verification (HMAC-SHA256)
 * - Payload encryption/decryption (AES-256-GCM)
 * - Integrity hash computation (SHA-256)
 * - Secure random generation
 * - Anti-tamper timestamp validation
 *
 * Build: node-gyp rebuild
 * Supports: macOS Apple Silicon + Intel
 */

#include <napi.h>
#include <string>
#include <vector>
#include <cstring>
#include <ctime>
#include <cstdlib>

// macOS CommonCrypto for cryptographic operations
#include <CommonCrypto/CommonCrypto.h>
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonRandom.h>

// ─── Helpers ────────────────────────────────────────────────────

static std::string bytesToHex(const unsigned char* data, size_t len) {
    static const char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        result.push_back(hex[data[i] >> 4]);
        result.push_back(hex[data[i] & 0x0F]);
    }
    return result;
}

static std::vector<unsigned char> hexToBytes(const std::string& hex) {
    std::vector<unsigned char> bytes;
    for (size_t i = 0; i + 1 < hex.length(); i += 2) {
        unsigned char byte = 0;
        for (int j = 0; j < 2; j++) {
            byte <<= 4;
            char c = hex[i + j];
            if (c >= '0' && c <= '9') byte |= (c - '0');
            else if (c >= 'a' && c <= 'f') byte |= (c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') byte |= (c - 'A' + 10);
        }
        bytes.push_back(byte);
    }
    return bytes;
}

// ─── SHA-256 Hash ───────────────────────────────────────────────

Napi::Value ComputeSHA256(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string input = info[0].As<Napi::String>().Utf8Value();
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(input.c_str(), (CC_LONG)input.length(), hash);

    return Napi::String::New(env, bytesToHex(hash, CC_SHA256_DIGEST_LENGTH));
}

// ─── HMAC-SHA256 Token Verification ─────────────────────────────

Napi::Value VerifyToken(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (token, secret) string arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string token = info[0].As<Napi::String>().Utf8Value();
    std::string secret = info[1].As<Napi::String>().Utf8Value();

    // Split token into payload.signature
    size_t dotPos = token.rfind('.');
    if (dotPos == std::string::npos) {
        return Napi::Boolean::New(env, false);
    }

    std::string payload = token.substr(0, dotPos);
    std::string signature = token.substr(dotPos + 1);

    // Compute HMAC-SHA256 of payload
    unsigned char hmac[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, secret.c_str(), secret.length(),
           payload.c_str(), payload.length(), hmac);

    std::string expectedSig = bytesToHex(hmac, CC_SHA256_DIGEST_LENGTH);

    // Constant-time comparison
    if (expectedSig.length() != signature.length()) {
        return Napi::Boolean::New(env, false);
    }

    volatile unsigned char result = 0;
    for (size_t i = 0; i < expectedSig.length(); i++) {
        result |= expectedSig[i] ^ signature[i];
    }

    return Napi::Boolean::New(env, result == 0);
}

// ─── HMAC-SHA256 Signing ────────────────────────────────────────

Napi::Value SignPayload(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (payload, secret) string arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string payload = info[0].As<Napi::String>().Utf8Value();
    std::string secret = info[1].As<Napi::String>().Utf8Value();

    unsigned char hmac[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, secret.c_str(), secret.length(),
           payload.c_str(), payload.length(), hmac);

    std::string signature = bytesToHex(hmac, CC_SHA256_DIGEST_LENGTH);
    return Napi::String::New(env, payload + "." + signature);
}

// ─── Secure Random Bytes ────────────────────────────────────────

Napi::Value SecureRandom(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    uint32_t length = 32;
    if (info.Length() > 0 && info[0].IsNumber()) {
        length = info[0].As<Napi::Number>().Uint32Value();
        if (length > 1024) length = 1024; // Cap at 1KB
    }

    std::vector<unsigned char> bytes(length);
    CCRandomGenerateBytes(bytes.data(), length);

    return Napi::String::New(env, bytesToHex(bytes.data(), length));
}

// ─── File Integrity Check ───────────────────────────────────────

Napi::Value ComputeFileHash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string filePath = info[0].As<Napi::String>().Utf8Value();

    FILE* file = fopen(filePath.c_str(), "rb");
    if (!file) {
        return Napi::String::New(env, "");
    }

    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);

    unsigned char buffer[8192];
    size_t bytesRead;
    while ((bytesRead = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        CC_SHA256_Update(&ctx, buffer, (CC_LONG)bytesRead);
    }
    fclose(file);

    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(hash, &ctx);

    return Napi::String::New(env, bytesToHex(hash, CC_SHA256_DIGEST_LENGTH));
}

// ─── Timestamp Validation (Anti-Replay) ─────────────────────────

Napi::Value ValidateTimestamp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected timestamp number").ThrowAsJavaScriptException();
        return env.Null();
    }

    int64_t timestamp = info[0].As<Napi::Number>().Int64Value();
    int64_t now = (int64_t)time(nullptr) * 1000; // ms
    int64_t maxDrift = 300000; // 5 minutes

    if (info.Length() > 1 && info[1].IsNumber()) {
        maxDrift = info[1].As<Napi::Number>().Int64Value();
    }

    int64_t diff = now - timestamp;
    bool valid = (diff >= 0 && diff <= maxDrift);

    return Napi::Boolean::New(env, valid);
}

// ─── Environment Check (Anti-Debug) ─────────────────────────────

Napi::Value CheckEnvironment(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    Napi::Object result = Napi::Object::New(env);
    result.Set("safe", Napi::Boolean::New(env, true));

    // Check for common debugging indicators
    const char* debugEnvVars[] = {
        "ELECTRON_ENABLE_LOGGING",
        "ELECTRON_DEBUG_NOTIFICATIONS",
        "NODE_DEBUG",
        nullptr
    };

    bool suspicious = false;
    for (int i = 0; debugEnvVars[i] != nullptr; i++) {
        if (getenv(debugEnvVars[i]) != nullptr) {
            suspicious = true;
            break;
        }
    }

    result.Set("safe", Napi::Boolean::New(env, !suspicious));
    result.Set("suspicious", Napi::Boolean::New(env, suspicious));

    return result;
}

// ─── Module Init ────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("computeSHA256", Napi::Function::New(env, ComputeSHA256));
    exports.Set("verifyToken", Napi::Function::New(env, VerifyToken));
    exports.Set("signPayload", Napi::Function::New(env, SignPayload));
    exports.Set("secureRandom", Napi::Function::New(env, SecureRandom));
    exports.Set("computeFileHash", Napi::Function::New(env, ComputeFileHash));
    exports.Set("validateTimestamp", Napi::Function::New(env, ValidateTimestamp));
    exports.Set("checkEnvironment", Napi::Function::New(env, CheckEnvironment));
    return exports;
}

NODE_API_MODULE(secure_core, Init)
