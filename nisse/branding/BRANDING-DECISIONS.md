# Nisse branding decisions (scaffold, M2-3)

These are **decision placeholders**; no core files are modified in M2. Execute in M5/M6
(desktop shell + release engineering), not by editing the DSH core beyond an approved patch.

| Item | Current (DSH upstream) | Nisse target | Where |
|---|---|---|---|
| Product name | DeepSeek Harness / DSH | Nisse（家灵） | Shell/window/installer; not core |
| App id / bundle id | com.deepseek.harness | e.g. com.nisse.app (TBD) | Shell packaging |
| URL schemes | dsh-app://, dsh:// | nisse:// (TBD; avoid colliding) | Shell |
| Icons/tray | 7 upstream resources | Nisse whale-girl assets (MIT) | Shell |
| User data dir | @deepseek-ai/dsh-desktop | Nisse-owned dir (TBD) | Shell/profile |
| Telemetry/account | upstream default | disable/opt-in (ADR) | Profile + shell |
| Default workspace | upstream | fixed Nisse workspace | Host Integration/profile |
| Version identity | Desktop must equal dsh base version | Nisse version mapping (ADR-0009) | Release engineering |
