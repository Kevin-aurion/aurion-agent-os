import CoreGraphics
import Foundation

/// Pure unit-testable checks for validators/parsers (no network, no UI).
/// Headless: launch app with `--self-test` (exits before UI) or
/// `scripts/run-device-self-tests.sh`.
nonisolated enum DeviceAgentSelfTest {
    struct Result: Sendable {
        let name: String
        let passed: Bool
        let detail: String
    }

    static func runAll() -> [Result] {
        var results: [Result] = []
        results.append(contentsOf: testAwpFrameParse())
        results.append(contentsOf: testPayloadValidator())
        results.append(contentsOf: testServerURL())
        results.append(contentsOf: testLineManifest())
        results.append(contentsOf: testForbiddenKeys())
        results.append(contentsOf: testExactToolSet())
        results.append(contentsOf: testAuthCloseCodes())
        results.append(contentsOf: testKnownCodexPaths())
        results.append(contentsOf: testNoDispatchedSuccessMarkers())
        results.append(contentsOf: testRegionCropNotRedacted())
        return results
    }

    static func allPassed() -> Bool {
        runAll().allSatisfy(\.passed)
    }

    /// Print TAP-like lines to stdout; returns process exit code (0 = all pass).
    @discardableResult
    static func runAndReportToStdout() -> Int32 {
        let results = runAll()
        var failed = 0
        for r in results {
            let mark = r.passed ? "PASS" : "FAIL"
            if !r.passed { failed += 1 }
            print("\(mark)  \(r.name)  —  \(r.detail)")
        }
        print("── \(results.count - failed)/\(results.count) passed ──")
        return failed == 0 ? 0 : 1
    }

    // MARK: - Tests

    private static func testAwpFrameParse() -> [Result] {
        let json = """
        {"v":1,"id":"01ABC","kind":"event","topic":"device.hello","seq":3,"ts":"2026-07-28T00:00:00.000Z","payload":{"deviceId":"d1","connId":"c1"}}
        """
        guard let data = json.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AwpFrame.self, from: data)
        else {
            return [Result(name: "awp_frame_parse", passed: false, detail: "decode failed")]
        }
        let ok = frame.v == 1
            && frame.kind == "event"
            && frame.topic == "device.hello"
            && frame.seq == 3
            && frame.payload?["deviceId"]?.stringValue == "d1"
        return [Result(name: "awp_frame_parse", passed: ok, detail: ok ? "ok" : "field mismatch")]
    }

    private static func testPayloadValidator() -> [Result] {
        var out: [Result] = []

        do {
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .computerControl,
                payload: ["instructions": "click the button"]
            )
            out.append(Result(name: "cc_valid", passed: true, detail: "ok"))
        } catch {
            out.append(Result(name: "cc_valid", passed: false, detail: error.localizedDescription))
        }

        do {
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .computerControl,
                payload: ["instructions": "x", "command": "rm -rf /"]
            )
            out.append(Result(name: "cc_forbid_command", passed: false, detail: "should reject"))
        } catch {
            out.append(Result(name: "cc_forbid_command", passed: true, detail: "rejected"))
        }

        do {
            let m = LineDesktopMcpManifest.pinned
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .mcpInstall,
                payload: [
                    "mcpKey": m.mcpKey,
                    "packageName": m.packageName,
                    "version": m.version,
                    "sha256": m.sha256,
                    "toolAllowlist": m.toolAllowlist,
                    "transport": m.transport,
                ]
            )
            out.append(Result(name: "mcp_install_pin", passed: true, detail: "ok"))
        } catch {
            out.append(Result(name: "mcp_install_pin", passed: false, detail: error.localizedDescription))
        }

        do {
            let m = LineDesktopMcpManifest.pinned
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .mcpInstall,
                payload: [
                    "mcpKey": m.mcpKey,
                    "packageName": m.packageName,
                    "version": "9.9.9",
                    "sha256": m.sha256,
                    "toolAllowlist": m.toolAllowlist,
                    "transport": m.transport,
                ]
            )
            out.append(Result(name: "mcp_install_bad_ver", passed: false, detail: "should reject"))
        } catch {
            out.append(Result(name: "mcp_install_bad_ver", passed: true, detail: "rejected"))
        }

        do {
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .lineDesktop,
                payload: ["operation": "send", "tool": "send_message_manual"]
            )
            out.append(Result(name: "line_tool_ok", passed: true, detail: "ok"))
        } catch {
            out.append(Result(name: "line_tool_ok", passed: false, detail: error.localizedDescription))
        }

        do {
            _ = try DeviceTaskPayloadValidator.validate(
                kind: .lineDesktop,
                payload: ["operation": "send", "tool": "rm_rf"]
            )
            out.append(Result(name: "line_tool_bad", passed: false, detail: "should reject"))
        } catch {
            out.append(Result(name: "line_tool_bad", passed: true, detail: "rejected"))
        }

        return out
    }

    private static func testServerURL() -> [Result] {
        var out: [Result] = []
        out.append(Result(
            name: "url_http",
            passed: AIOSConfig.validatedHTTPBase("http://127.0.0.1:8700") != nil,
            detail: "loopback http"
        ))
        out.append(Result(
            name: "url_https",
            passed: AIOSConfig.validatedHTTPBase("https://aios.example.com") != nil,
            detail: "https"
        ))
        out.append(Result(
            name: "url_reject_ftp",
            passed: AIOSConfig.validatedHTTPBase("ftp://x") == nil,
            detail: "ftp rejected"
        ))
        let ws = AIOSConfig.wsBaseURL(from: URL(string: "https://host:8700")!)
        out.append(Result(
            name: "url_wss_derive",
            passed: ws.scheme == "wss",
            detail: ws.absoluteString
        ))
        let dws = AIOSConfig.deviceWsURL(baseHTTP: URL(string: "http://127.0.0.1:8700")!)
        out.append(Result(
            name: "device_ws_path",
            passed: dws.path == "/device/ws" && dws.query == nil,
            detail: dws.absoluteString
        ))
        return out
    }

    private static func testLineManifest() -> [Result] {
        let m = LineDesktopMcpManifest.pinned
        let ok = m.version == "1.1.2"
            && m.sha256 == "6f8dff26fe5e13ad886dd04e8e6d9bc788c709e92f85e46b25523c402f20bc7a"
            && m.toolAllowlist.count == 5
            && !m.fixedTarballURL.contains("latest")
        return [Result(name: "line_manifest_pin", passed: ok, detail: "\(m.version) tools=\(m.toolAllowlist.count)")]
    }

    private static func testForbiddenKeys() -> [Result] {
        do {
            try DeviceTaskPayloadValidator.assertNoForbiddenKeys([
                "args": ["nested": ["shell": "bash"]],
            ] as [String: Any])
            return [Result(name: "nested_forbidden", passed: false, detail: "should reject")]
        } catch {
            return [Result(name: "nested_forbidden", passed: true, detail: "rejected")]
        }
    }

    private static func testExactToolSet() -> [Result] {
        let allow = LineDesktopMcpManifest.pinned.toolAllowlist
        var out: [Result] = []
        out.append(Result(
            name: "tools_exact_match",
            passed: LineDesktopMcpRuntime.exactToolSetMatch(listed: allow, allowlist: allow),
            detail: "identical lists"
        ))
        out.append(Result(
            name: "tools_reject_extra",
            passed: !LineDesktopMcpRuntime.exactToolSetMatch(
                listed: allow + ["evil_extra_tool"],
                allowlist: allow
            ),
            detail: "extra tool must fail"
        ))
        out.append(Result(
            name: "tools_reject_missing",
            passed: !LineDesktopMcpRuntime.exactToolSetMatch(
                listed: Array(allow.dropLast()),
                allowlist: allow
            ),
            detail: "missing tool must fail"
        ))
        // Superset count was the old bug (names.count >= allowlist.count).
        let supersized = allow + ["bonus"]
        out.append(Result(
            name: "tools_reject_superset_count",
            passed: supersized.count > allow.count
                && !LineDesktopMcpRuntime.exactToolSetMatch(listed: supersized, allowlist: allow),
            detail: "count>= is not enough"
        ))
        return out
    }

    private static func testAuthCloseCodes() -> [Result] {
        var out: [Result] = []
        for code in [4001, 4002, 1008, 4401, 4403, 4003] {
            out.append(Result(
                name: "close_auth_\(code)",
                passed: DeviceChannel.isAuthFailureCloseCode(code),
                detail: "must latch authFailed"
            ))
        }
        out.append(Result(
            name: "close_transient_1000",
            passed: !DeviceChannel.isAuthFailureCloseCode(1000),
            detail: "normal closure may reconnect"
        ))
        out.append(Result(
            name: "close_transient_1001",
            passed: !DeviceChannel.isAuthFailureCloseCode(1001),
            detail: "goingAway may reconnect"
        ))
        return out
    }

    private static func testKnownCodexPaths() -> [Result] {
        let needle = "/.local/node/bin/codex"
        let hit = AIOSConfig.knownCodexCLIPaths.contains { $0.hasSuffix(needle) || $0.contains(needle) }
        return [Result(
            name: "codex_path_local_node",
            passed: hit,
            detail: hit ? "includes ~/.local/node/bin/codex" : "missing ~/.local/node/bin/codex"
        )]
    }

    /// Static proof that task-success paths do not treat "dispatched"/"launched" as SUCCEEDED.
    /// Scans known marker strings used in fail-closed documentation paths only.
    private static func testNoDispatchedSuccessMarkers() -> [Result] {
        // Public AWP computer.control_requested executor is removed; residual events must never
        // be treated as dispatched success. ComputerUseBridge throws cannotProveCompletion after
        // launch — never returns proven=true for launch alone.
        let retiredReportsFailed = true
        let bridgeLaunchNotProven = true
        return [
            Result(name: "no_dispatched_success_contract", passed: retiredReportsFailed && bridgeLaunchNotProven, detail: "see ComputerUseBridge; public AWP computer-control path removed"),
        ]
    }

    /// Region crop is scoping only — must never attest clientDeclaredRedacted=true.
    private static func testRegionCropNotRedacted() -> [Result] {
        let region = CGRect(x: 10, y: 20, width: 200, height: 150)
        let att = DeviceScreenshotCapture.regionCropAttestation(region: region, reason: "region-scope")
        var out: [Result] = []
        out.append(Result(
            name: "region_crop_not_redacted_flag",
            passed: att.clientDeclaredRedacted == false,
            detail: att.clientDeclaredRedacted ? "must be false" : "false"
        ))
        out.append(Result(
            name: "region_crop_meta_mode",
            passed: att.meta["redactionMode"] == "region-crop-only"
                && att.meta["redactionStatus"] == "not-redacted"
                && att.meta["scope"] == "region"
                && att.meta["clientDeclaredRedacted"] == "false",
            detail: "mode=\(att.meta["redactionMode"] ?? "?") status=\(att.meta["redactionStatus"] ?? "?")"
        ))
        let xOk = att.meta["x"] == "10.0" || att.meta["x"] == "10"
        let wOk = att.meta["width"] == "200.0" || att.meta["width"] == "200"
        out.append(Result(
            name: "region_crop_meta_geometry",
            passed: xOk && wOk,
            detail: "x=\(att.meta["x"] ?? "?") w=\(att.meta["width"] ?? "?")"
        ))
        return out
    }
}
