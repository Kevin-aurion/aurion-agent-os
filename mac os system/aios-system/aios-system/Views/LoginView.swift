import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var app
    @State private var initialized = true
    @State private var email = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var error = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "cpu.fill").font(.system(size: 40)).foregroundStyle(.tint)
            Text(initialized ? "登入 AIOS" : "建立擁有者帳號").font(.title2).bold()
            Text(initialized ? "本地代理工作站" : "第一個帳號將成為系統擁有者").font(.caption).foregroundStyle(.secondary)

            VStack(spacing: 10) {
                if !initialized {
                    TextField("顯示名稱", text: $displayName).textFieldStyle(.roundedBorder)
                }
                TextField("Email", text: $email).textFieldStyle(.roundedBorder)
                SecureField("密碼", text: $password).textFieldStyle(.roundedBorder)
            }.frame(width: 300)

            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }

            Button(action: submit) {
                if busy { ProgressView().controlSize(.small) }
                else { Text(initialized ? "登入" : "建立並登入") }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || email.isEmpty || password.isEmpty)
        }
        .padding(40)
        .task {
            if let status: AuthStatus = try? await APIClient.shared.request("/api/auth/status", authed: false) {
                initialized = status.initialized
            }
        }
    }

    private func submit() {
        busy = true; error = ""
        Task {
            do { try await app.login(email: email, password: password, register: !initialized, displayName: displayName) }
            catch let e as APIClient.APIError { error = e.message }
            catch { self.error = "登入失敗" }
            busy = false
        }
    }
}
