"""Normalize desktop state without changing the native thread or provider."""
import copy
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname
import ntpath



def apply_patches(state, patches):
    for patch in patches:
        path = patch.get("path", [])
        if isinstance(path, str):
            path = [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]
        if not path:
            if patch["op"] != "replace":
                raise ValueError("Unsupported root patch")
            state = copy.deepcopy(patch["value"])
            continue
        target = state
        for key in path[:-1]:
            target = target[int(key)] if isinstance(target, list) else target[key]
        key = path[-1]
        operation = patch["op"]
        if isinstance(target, list):
            index = len(target) if key == "-" else int(key)
            if operation == "add":
                target.insert(index, copy.deepcopy(patch["value"]))
            elif operation == "remove":
                target.pop(index)
            elif operation == "replace":
                target[index] = copy.deepcopy(patch["value"])
            else:
                raise ValueError("Unsupported list patch")
        elif operation == "remove":
            del target[key]
        elif operation in ("replace", "add"):
            target[key] = copy.deepcopy(patch["value"])
        else:
            raise ValueError("Unsupported patch")
    return state


def ordered_turns(state):
    history = state.get("turnHistory", {})
    if history.get("kind") != "canonical":
        return state.get("turns", [])
    history = history.get("history", {})
    entities = history.get("entitiesByKey", {})
    turns, seen = [], set()
    for island in history.get("islands", []):
        for entry in island.get("entries", []):
            key = entry.get("value")
            if key in entities and key not in seen:
                seen.add(key)
                turns.append(entities[key])
    return turns


def text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict) and x.get("type") in ("text", "input_text", "output_text", "inputText"))
    return ""


def user_text_content(content):
    """Omit transport labels only when they directly frame an image item."""
    if not isinstance(content, list):
        return text_content(content)
    hidden = set()
    for index, part in enumerate(content):
        if not isinstance(part, dict) or part.get('type') not in ('input_image', 'localImage', 'image'):
            continue
        if index == 0 or index + 1 == len(content):
            continue
        before, after = content[index - 1], content[index + 1]
        if not all(isinstance(value, dict) and value.get('type') in ('text', 'input_text', 'inputText')
                   and isinstance(value.get('text'), str) for value in (before, after)):
            continue
        if (re.fullmatch(r'<image name=\[Image #\d+\] path="[^"\r\n]+">', before['text'].strip())
                and after['text'].strip() == '</image>'):
            hidden.update((index - 1, index + 1))
    return text_content([part for index, part in enumerate(content) if index not in hidden])


def items_array(items):
    if isinstance(items, list):
        return items
    if isinstance(items, dict):
        entities = items.get("entitiesByKey", {})
        if entities:
            return [entities[e["value"]] for island in items.get("islands", []) for e in island.get("entries", []) if e.get("value") in entities]
        return list(items.get("items", []))
    return []


def request_id(item):
    """Return the bridge submission id attached to a desktop user message."""
    return item.get("clientId") or item.get("clientUserMessageId") or item.get("client_id")


def user_display_text(text):
    """Hide desktop attachment plumbing from the phone-visible request."""
    if not isinstance(text, str) or "# Files mentioned by the user:" not in text:
        return text
    marker = "\n## My request:\n"
    header = text.find("# Files mentioned by the user:")
    boundary = text.rfind(marker)
    if header < 0 or boundary <= header:
        return text
    request = text[boundary + len(marker):].strip("\r\n")
    return request or text


def is_user_context(text):
    """Recognize complete desktop context envelopes, not quoted user requests."""
    text = text.strip()
    environment = r'<environment_context>.*?</environment_context>'
    if text.startswith('# AGENTS.md instructions for '):
        _, separator, body = text.partition('\n')
        return bool(separator and re.fullmatch(r'\s*<INSTRUCTIONS>.*?</INSTRUCTIONS>(?:\s*' + environment + r')?\s*', body, re.S))
    envelope = (r'(?:<user_instructions>.*?</user_instructions>|<skill>.*?</skill>|'
                r'<subagent_notification>.*?</subagent_notification>|'
                r'<external_codex_apps_open_page>.*?</external_codex_apps_open_page>|' + environment + r')')
    return bool(re.fullmatch(envelope + r'(?:\s*' + envelope + r')*', text, re.S))


def embedded_image_id(value):
    """Opaque identity for an image already embedded in this chat's record."""
    if isinstance(value, str) and re.match(r'^data:image/(?:png|jpeg|gif|webp);base64,', value):
        return hashlib.sha256(('embedded:' + value).encode()).hexdigest()
    return None


def incoming_thread_message(item):
    """Recognize the app's incoming main-chat envelope, never a tool's reply."""
    if (item.get('type') not in ('function_call_output', 'functionCallOutput')
            or item.get('namespace') != 'codex_app'
            or item.get('name') not in ('create_thread', 'send_message_to_thread')
            or item.get('call_id') or item.get('callId')):
        return None
    output = item.get('output')
    if isinstance(output, dict):
        output = output.get('text')
    if not isinstance(output, str):
        return None
    identifier = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
    match = re.fullmatch(r'\s*<codex_delegation>\s*<source_thread_id>(' + identifier
                         + r')</source_thread_id>\s*<input>(.*)</input>\s*</codex_delegation>\s*', output, re.S)
    if match:
        return {'kind': 'threadMessage', 'role': 'user', 'text': match[2], 'sourceThreadId': match[1]}
    return None


def normalize_item(item):
    kind = item.get("type", "unknown")
    row = {"id": item.get("id"), "kind": kind, "status": item.get("status")}
    row.update({key: item[key] for key in ('navigationId', 'navigationPosition') if key in item})
    timestamp = next((item[key] for key in ('timestamp', 'startedAtMs', 'createdAtMs', 'started_at_ms', 'createdAt', 'created_at')
                      if item.get(key) is not None), None)
    if timestamp is not None:
        row['timestamp'] = timestamp
    incoming = incoming_thread_message(item)
    if incoming:
        row.update(incoming)
    elif kind in ("userMessage", "steeringUserMessage"):
        if kind == "steeringUserMessage":
            item = {**item, "content": item.get("input", [])}
        submission_request_id = request_id(item)
        if request_id:
            row["requestId"] = str(submission_request_id)
        text = user_display_text(user_text_content(item.get("content", [])))
        if is_user_context(text):
            row['isUserContext'] = True
        replies = question_replies(text)
        if replies:
            text = "\n\n".join(str(r.get("question", "")) + "\n" + str(r.get("answer", "")) for r in replies)
        row.update(role="user", text=text)
    elif kind in ("agentMessage", "assistantMessage"):
        row.update(role="assistant", text=item.get("text", ""), phase=item.get("phase"))
    elif kind in ("ImageView", "imageView"):
        raw = item.get("path", "")
        path = raw
        try:
            parsed = urlsplit(raw)
            if parsed.scheme == "file" and parsed.netloc in ("", "localhost"):
                file_path = unquote(parsed.path)
                # file:///D:/... has a leading slash on Windows too.
                if re.fullmatch(r"/[A-Za-z]:[\\/].+", file_path):
                    file_path = file_path[1:]
                path = url2pathname(file_path)
        except ValueError:
            path = raw
        row.update(role="activity", title="图片预览", text="", phase="commentary")
        if path:
            row["attachments"] = [{"type": "localImage", "path": path, "name": Path(path).name}]
    elif kind == "reasoning":
        summary = item.get('summary') or []
        if isinstance(summary, str):
            text = summary
        elif isinstance(summary, list):
            parts = [part if isinstance(part, str) else part.get('text', '')
                     for part in summary if isinstance(part, str)
                     or isinstance(part, dict) and part.get('type') == 'summary_text']
            text = '\n'.join(part for part in parts if isinstance(part, str))
        else:
            text = ''
        row.update(role="activity", title="思考摘要", text=text)
        # Only the public summary belongs in the display projection. Other
        # reasoning content is neither a summary fallback nor an attachment.
        return row
    elif kind == "commandExecution":
        row.update(role="activity", title="执行命令", text=item.get("command", ""), output=item.get("aggregatedOutput", ""), exitCode=item.get("exitCode"))
    elif kind == "fileChange":
        row.update(role="activity", title="文件变更", text="\n\n".join(str(c.get("path", "")) + "\n" + str(c.get("diff", "")) for c in item.get("changes", [])))
    elif kind in ("mcpToolCall", "dynamicToolCall"):
        row.update(role="activity", title=" · ".join(str(x) for x in (item.get("server"), item.get("tool", item.get("toolName"))) if x), text=json.dumps(item.get("arguments", {}), ensure_ascii=False, indent=2), output=json.dumps(item.get("result", item.get("contentItems", item.get("error", ""))), ensure_ascii=False, indent=2))
    elif kind == "error":
        row.update(role="error", text=item.get("message", "执行失败"))
    elif kind == "planImplementation":
        row.update(role="assistant", title="计划", text=item.get("planContent", ""))
    else:
        row.update(role="activity", title=kind, text=json.dumps(item, ensure_ascii=False, indent=2))
    # Preserve non-text attachment descriptors. They are not fetched from arbitrary URLs.
    attachments = [x for x in item.get("content", []) if isinstance(x, dict) and x.get("type") not in ("text", "input_text", "output_text")] if isinstance(item.get("content"), list) else []
    if attachments:
        row["attachments"] = []
        for attachment in attachments:
            image_id = embedded_image_id(attachment.get('image_url')) if attachment.get('type') == 'input_image' else None
            row['attachments'].append({'type': 'image', 'name': '图片附件', 'desktopId': image_id} if image_id else attachment)
    return row


def permission_values(state):
    turns = ordered_turns(state)
    latest = state.get('latestThreadSettings') or {}
    params = (turns[-1].get('params') or {}) if turns else {}
    current = state.get('currentPermissions') or {}
    return {**current, **params, **latest}


def permission_details(state):
    """Display facts only; a custom combination must never become a preset."""
    values = permission_values(state)
    profile = values.get('activePermissionProfile') or {}
    profile_id = values.get('permissions') or profile.get('id')
    sandbox = {':danger-full-access': 'dangerFullAccess', ':workspace': 'workspaceWrite'}.get(profile_id)
    if not profile_id:
        sandbox = (values.get('sandboxPolicy') or {}).get('type')
    return {'sandbox': sandbox, 'approvalPolicy': values.get('approvalPolicy')}


def permission_mode(state, *, legacy_reviewer=False):
    values = permission_values(state)
    profile = values.get('activePermissionProfile') or {}
    profile_id = values.get('permissions') or profile.get('id')
    policy = values.get('sandboxPolicy') or {}
    if profile_id == ':danger-full-access' or (not profile_id and policy.get('type') == 'dangerFullAccess'):
        return 'full-access' if values.get('approvalPolicy') == 'never' else 'custom'
    if profile_id == ':workspace' or (not profile_id and policy.get('type') == 'workspaceWrite'):
        if values.get('approvalPolicy') == 'on-request':
            reviewer = values.get('approvalsReviewer')
            return 'auto-review' if reviewer == 'auto_review' or (legacy_reviewer and reviewer == 'guardian_subagent') else 'ask'
    return 'custom'


def context_usage(state):
    """Last request occupancy, never the cumulative thread billing counter."""
    info = state.get('latestTokenUsageInfo')
    if not isinstance(info, dict): return None
    last = info.get('last')
    if not isinstance(last, dict): return None
    used, window = last.get('totalTokens'), info.get('modelContextWindow')
    if type(used) is not int or used < 0: return None
    return {'usedTokens': used,
            'contextWindow': window if type(window) is int and window > 0 else None,
            'cached': state.get('tokenUsageFromHistory') is True}


def session_title(state, first_user_text=''):
    """Prefer the native name, then a short preview while auto-naming is pending."""
    title = state.get('name') or state.get('title')
    first = state.get('first_user_message') or first_user_text
    raw_message_title = not state.get('name') and first and title == first
    if isinstance(title, str) and title.strip() and not raw_message_title:
        return title
    preview = state.get('preview') or state.get('first_user_message') or first_user_text
    if isinstance(preview, str):
        summary = ' '.join(user_display_text(preview).split())
        if summary:
            return summary[:28] + ('…' if len(summary) > 28 else '')
    return '未命名聊天'


def session_title_source(state, first_user_text=''):
    first = state.get('first_user_message') or first_user_text
    if not state.get('name') and first and state.get('title') == first:
        return 'preview'
    if any(isinstance(state.get(key), str) and state[key].strip() for key in ('name', 'title')):
        return 'native'
    if state.get('preview') or state.get('first_user_message'):
        return 'preview'
    return 'message' if first_user_text else 'placeholder'


def normalize_state(state, connected=True):
    turns = ordered_turns(state)
    result = []
    recorded_starts = state.get('itemStartedAtMsById') or {}
    for ordinal, turn in enumerate(turns):
        items = items_array(turn.get("items", []))
        messages, calls = [], {}
        for item in items:
            kind = item.get('type')
            if kind in ('function_call', 'custom_tool_call'):
                message = {'id': item.get('call_id', item.get('id')), 'kind': 'storedToolEvent',
                           'role': 'activity', 'title': item.get('name') or '工具调用',
                           'text': str(item.get('arguments', item.get('input', '')))}
                calls[message['id']] = message
                if 'navigationPosition' in item:
                    message['navigationPosition'] = item['navigationPosition']
                if item.get('timestamp') is not None:
                    message['timestamp'] = item['timestamp']
                messages.append(message)
            elif kind in ('function_call_output', 'custom_tool_call_output') and item.get('call_id') in calls:
                output = item.get('output', '')
                calls[item['call_id']]['output'] = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
            else:
                messages.append(normalize_item(item))
        if not any(x.get("role") == "user" for x in messages):
            opening = text_content(turn.get("params", {}).get("input", []))
            if opening:
                messages.insert(0, {"id": "opening-" + str(turn.get("turnId", ordinal)), "role": "user", "kind": "userMessage", "text": opening})
        params = turn.get('params') or {}
        starts = {**(turn.get('itemStartedAtMsById') or {}),
                  **(turn.get('aeonAssistantMessageStartedAtMsById') or {}),
                  **(turn.get('commandExecutionStartedAtMsById') or {})}
        first_user = next((message for message in messages if message['role'] == 'user'
                           and not message.get('isUserContext') and message.get('kind') != 'threadMessage'), None)
        for message in messages:
            timestamp = starts.get(message['id'], recorded_starts.get(message['id']))
            if timestamp is None and message is first_user and not message.get('timestamp'):
                timestamp = turn.get('turnStartedAtMs')
            if timestamp is not None:
                message['timestamp'] = timestamp
        settings = (params.get('collaborationMode') or {}).get('settings') or {}
        model = params.get('model') or settings.get('model') or turn.get('model')
        effort = params.get('effort') or params.get('reasoningEffort') or settings.get('reasoning_effort') or turn.get('reasoningEffort')
        result.append({"model": model, "effort": effort, "id": turn.get("turnId") or str(ordinal), "status": turn.get("status"),
                       "startedAt": turn.get("turnStartedAtMs"), "messages": messages,
                       **({'firstUserMessageId': turn['firstUserMessageId']} if 'firstUserMessageId' in turn else {}),
                       "actionable": turn.get('actionable', True) and bool(turn.get("turnId")) and turn.get("turnId") != "history",
                       "error": turn.get("error"), "diff": turn.get("diff")})
    history = state.get("turnHistory", {}).get("history", {})
    settings = state.get('latestThreadSettings') or {}
    params = (turns[-1].get('params') or {}) if turns else {}
    collaboration = settings.get('collaborationMode') or state.get('latestCollaborationMode') or params.get('collaborationMode') or {}
    model_settings = collaboration.get('settings') or {}
    model = state.get('latestModel') or settings.get('model') or model_settings.get('model') or params.get('model')
    effort = (state.get('latestReasoningEffort') or settings.get('effort') or settings.get('reasoningEffort')
              or settings.get('reasoning_effort') or model_settings.get('reasoning_effort')
              or params.get('effort') or params.get('reasoningEffort'))
    tier = settings if 'serviceTier' in settings else (turns[-1].get('params') or {}) if turns else {}
    first_user_text = next((message.get('text', '') for turn in result for message in turn['messages']
                            if message.get('role') == 'user' and message.get('text')), '')
    return {"id": state.get("id", state.get("sessionId")), "title": session_title(state, first_user_text),
            "titleSource": session_title_source(state, first_user_text),
            "cwd": state.get("cwd"), "model": model, "provider": state.get("modelProvider"), "effort": effort,
            "connected": connected, "status": state.get("threadRuntimeStatus", {}).get("type", "idle"),
            "permissionMode": permission_mode(state),
            "permissionDetails": permission_details(state),
            "contextUsage": context_usage(state),
            "collaborationMode": (state.get("latestCollaborationMode") or {}).get("mode"),
            **({'serviceTier': tier['serviceTier']} if 'serviceTier' in tier else {}),
            "goal": copy.deepcopy(state.get("threadGoal") or state.get("completedThreadGoal")),
            "turns": result, "requests": pending_requests(state),
            "historyComplete": history.get("isComplete", state.get("turnsPagination", {}).get("hasLoadedOldest", True))}


def waiting_for_user(state):
    """Match actionable detail requests without projecting history or bodies."""
    return bool(state.get('requests') or async_requests(state))


def pending_requests(state):
    turns = ordered_turns(state)
    requests = []
    for request in state.get("requests", []):
        normalized = normalize_request(request)
        item_id = request.get("params", {}).get("itemId")
        related = next((item for turn in turns for item in items_array(turn.get("items")) if item.get("id") == item_id), None) if item_id else None
        if related and normalized["supported"]:
            if request.get("method") == "item/fileChange/requestApproval":
                normalized["params"]["changes"] = copy.deepcopy(related.get("changes", []))
            elif request.get("method") == "item/commandExecution/requestApproval" and not normalized["params"].get("command"):
                normalized["params"]["command"] = related.get("command", "")
        requests.append(normalized)
    return requests + async_requests(state)


def computer_use_approval(params):
    """Expose only the scope choices present in the live desktop approval."""
    meta = params.get('_meta') or {}
    if not isinstance(meta, dict) or meta.get('codex_approval_kind') != 'mcp_tool_call':
        return None
    connector = re.sub(r'[^a-z0-9]+', '-', str(meta.get('connector_id', '')).lower()).strip('-')
    tool = meta.get('tool_params') or {}
    app = tool.get('app') if isinstance(tool, dict) else None
    schema = params.get('requestedSchema') or {}
    if (params.get('mode', 'form') != 'form' or not (connector == 'computer-use' or connector.startswith('computer-use-'))
            or not isinstance(app, str) or not app.strip() or schema.get('properties') or schema.get('required')):
        return None
    modes = meta.get('persist', [])
    if isinstance(modes, str):
        modes = [modes]
    if not isinstance(modes, list):
        modes = []
    return {'app': app, 'persistModes': [mode for mode in ('session', 'always') if mode in modes]}


def normalize_request(request):
    result = {"id": request.get("id"), "method": request.get("method"), "params": {}}
    params = request.get("params", {})
    method = request.get("method")
    fields = {
        "item/commandExecution/requestApproval": ("command", "cwd", "reason", "availableDecisions", "networkApprovalContext"),
        "item/fileChange/requestApproval": ("reason", "grantRoot", "changes"),
        "item/permissions/requestApproval": ("reason", "permissions"),
        "item/tool/requestUserInput": ("questions", "turnId", "itemId"),
        "tool/requestUserInput": ("questions", "turnId", "itemId"),
        "item/plan/requestImplementation": ("turnId", "planContent"),
        "mcpServer/elicitation/request": ("serverName", "message", "mode", "requestedSchema"),
    }
    # Identity verification is intentionally desktop-only, including its challenge data.
    verification = "openai/userVerification" in json.dumps(params.get("_meta", {})) or "openai/userVerification" in params
    result["supported"] = method in fields and not verification
    if method == "mcpServer/elicitation/request" and (params.get("mode", "form") != "form" or not form_supported(params.get("requestedSchema", {}))):
        result["supported"] = False
    if result["supported"]:
        result["params"] = {k: copy.deepcopy(params[k]) for k in fields[method] if k in params}
        if method == 'mcpServer/elicitation/request':
            computer = computer_use_approval(params)
            if computer:
                result['params']['computerUse'] = computer
    else:
        result["params"] = {"message": "请在桌面 App 处理此请求"}
    return result


def form_supported(schema):
    if schema.get("type") != "object" or set(schema) - {"type", "properties", "required", "title", "description", "$schema", "additionalProperties"}:
        return False
    allowed = {"type", "title", "description", "enum", "enumNames", "default", "minLength", "maxLength", "minimum", "maximum"}
    return all(isinstance(field, dict) and not set(field) - allowed and field.get("type", "string") in ("string", "number", "integer", "boolean") for field in schema.get("properties", {}).values())


def question_replies(text):
    prefix, suffix = "<send_user_message_question_reply>", "</send_user_message_question_reply>"
    if not text.strip().startswith(prefix) or not text.strip().endswith(suffix):
        return []
    try:
        value = json.loads(text.strip()[len(prefix):-len(suffix)])
        return value if isinstance(value, list) and all(isinstance(r, dict) for r in value) else []
    except ValueError:
        return []


def async_requests(state):
    result = []
    turns = ordered_turns(state)
    for turn in turns[-1:]:
        if turn.get("status") not in ("inProgress", "completed"):
            continue
        items = items_array(turn.get("items"))
        answered = set()
        for item in items:
            if item.get("type") == "userMessage" or (item.get("type") == "steeringUserMessage" and item.get("status") == "accepted"):
                text = text_content(item.get("content", item.get("input", [])))
                answered.update(r.get("questionItemId") for r in question_replies(text))
        for item in items:
            if item.get("type") != "agentMessage" or not item.get("questions"):
                continue
            questions = []
            for index, question in enumerate(item["questions"]):
                key = json.dumps(["request_user_input_async", item["id"], index], ensure_ascii=False, separators=(",", ":"))
                if key not in answered:
                    questions.append({"id": key, "question": question["title"], "options": [{"label": o} for o in (question.get("options") or [])]})
            if questions:
                result.append({"id": "async:" + str(turn.get("turnId")) + ":" + item["id"], "method": "bridge/requestUserInputAsync",
                               "supported": True, "params": {"questions": questions}})
    return result
