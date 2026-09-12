---
description: "Human-facing native IM contacts, chats, groups, and attachments."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-im

English | [中文](README.zh.md)

## Summary

Browse contacts, open private chats, create and manage groups, and view text, images, and files sent by people or AI participants. The panel is bound to the profile's local human identity; Agent page selection is separate from this browser view.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The optional [IM overlay](../../../apps/cli/config/examples/im/cordis.yml) enables the IM service, Agent runtime, and panel in the Web profile. Its viewer identity, polling interval, and conversation limits are explicit configuration. [IM](../../interaction/im/README.md) owns contact permissions and Agent notification/page behavior.

Contacts open private chats; group creation uses selected contacts. Group owners can rename groups, invite contacts, and remove members while retaining the owner and at least two members. Removing a contact retains chat history and group membership. Files are downloaded through a visible message, and images are displayed inline. Polling retries after a failure once the configured interval is known; the retry button handles initial connection failure.

## Model Experience

<a id="model-experience"></a>

### Human messages

#### What the model sees

The panel sends through the IM service. The bound Agent's page determines whether it receives message contents or a sender/count notification.

#### Token effect

Navigation and attachment downloads do not create model requests; IM admission owns model inputs.

#### KV Cache effect

Browser navigation does not change the Agent's selected page or model history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Full assembled-browser and recorded Session validation are pending. The panel represents one local profile owner; it does not provide multi-user sign-in. Chat history is fetched in full up to the service's retention limits.

<a id="dev-note"></a>
### Dev Note

The host Remote API binds every request to its configured viewer and checks conversation visibility before reading messages or attachments. No invariant companion is published: the panel reads the authoritative IM service and maintains no independently authoritative relationship state.
