"""
Build the iOS Shortcut as an unsigned .plist shortcut file.

An honest note on what this can and cannot be: Apple only lets a shortcut be imported
*frictionlessly* from an iCloud link, and iCloud links can only be produced by a human
tapping Share on a real device. Nobody but the owner can create one. What CAN be generated
is the underlying unsigned shortcut plist, which imports if "Allow Untrusted Shortcuts" is
enabled in Settings.

So this ships both: the file for people who want it, and a five-action manual recipe in
clients/ios/README.md for people who would rather not touch that setting. The manual route is
the recommended one — it is about two minutes and needs no settings changes.

Run: python3 scripts/build-ios-shortcut.py
"""
import plistlib
import uuid


def action(identifier, params=None):
    return {
        'WFWorkflowActionIdentifier': identifier,
        'WFWorkflowActionParameters': params or {},
    }


def magic_variable(output_uuid, name):
    """A reference to an earlier action's output — Shortcuts' 'magic variable'."""
    return {
        'Value': {
            'Type': 'ActionOutput',
            'OutputUUID': output_uuid,
            'OutputName': name,
        },
        'WFSerializationType': 'WFTextTokenAttachment',
    }


def text_with_variable(prefix, attachment_at, attachment):
    """Interpolated text: 'prefix' with a variable spliced in at a character offset."""
    return {
        'Value': {
            'string': prefix,
            'attachmentsByRange': {f'{{{attachment_at}, 1}}': attachment},
        },
        'WFSerializationType': 'WFTextTokenString',
    }


SHORTCUT_INPUT = {
    'Value': {'Type': 'ExtensionInput'},
    'WFSerializationType': 'WFTextTokenAttachment',
}

url_action_uuid = str(uuid.uuid4()).upper()

actions = [
    # 1. Combine whatever the share sheet gave us into one text blob. The pipeline is built to
    #    tolerate messy input, so we deliberately do not try to be clever here.
    action(
        'is.workflow.actions.gettext',
        {
            'UUID': str(uuid.uuid4()).upper(),
            'WFTextActionText': text_with_variable('￼', 0, SHORTCUT_INPUT),
        },
    ),
    # 2. POST it. The two placeholders are what the user edits after import.
    action(
        'is.workflow.actions.downloadurl',
        {
            'UUID': url_action_uuid,
            'WFURL': 'https://LATER-BASE-URL-HERE/api/ingest',
            'WFHTTPMethod': 'POST',
            'WFHTTPHeaders': {
                'Value': {
                    'WFDictionaryFieldValueItems': [
                        {
                            'WFItemType': 0,
                            'WFKey': {
                                'Value': {'string': 'Authorization'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                            'WFValue': {
                                'Value': {'string': 'Bearer LATER-INGEST-TOKEN-HERE'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                        }
                    ]
                },
                'WFSerializationType': 'WFDictionaryFieldValue',
            },
            'WFHTTPBodyType': 'JSON',
            'WFJSONValues': {
                'Value': {
                    'WFDictionaryFieldValueItems': [
                        {
                            'WFItemType': 0,
                            'WFKey': {
                                'Value': {'string': 'text'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                            'WFValue': {
                                'Value': {
                                    'string': '￼',
                                    'attachmentsByRange': {'{0, 1}': SHORTCUT_INPUT},
                                },
                                'WFSerializationType': 'WFTextTokenString',
                            },
                        },
                        {
                            'WFItemType': 0,
                            'WFKey': {
                                'Value': {'string': 'source'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                            'WFValue': {
                                'Value': {'string': 'ios-shortcut'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                        },
                    ]
                },
                'WFSerializationType': 'WFDictionaryFieldValue',
            },
        },
    ),
    # 3. Confirm. Later answers 202 immediately, so this appears at once rather than waiting
    #    on the pipeline — which is the whole point of the async design.
    action(
        'is.workflow.actions.shownotification',
        {
            'WFNotificationActionTitle': 'Later',
            'WFNotificationActionBody': 'Sent to Later',
            'WFNotificationActionSound': False,
        },
    ),
]

shortcut = {
    'WFWorkflowClientVersion': '2605.0.5',
    'WFWorkflowMinimumClientVersion': 900,
    'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {
        'WFWorkflowIconStartColor': 946986751,  # blue, to match the app
        'WFWorkflowIconGlyphNumber': 59511,  # bookmark
    },
    'WFWorkflowImportQuestions': [],
    'WFWorkflowTypes': ['ActionExtension'],  # makes it appear in the share sheet
    'WFWorkflowInputContentItemClasses': [
        'WFURLContentItem',
        'WFStringContentItem',
        'WFRichTextContentItem',
        'WFSafariWebPageContentItem',
    ],
    'WFWorkflowActions': actions,
    'WFQuickActionSurfaces': [],
    'WFWorkflowHasOutputFallback': False,
    'WFWorkflowHasShortcutInputVariables': True,
    'WFWorkflowNoInputBehavior': {
        'Name': 'WFWorkflowNoInputBehaviorShowError',
        'Parameters': {},
    },
}

path = 'clients/ios/Later.plist'
with open(path, 'wb') as f:
    plistlib.dump(shortcut, f)

# Read it back — a malformed plist is worse than no file, because it fails on the phone.
with open(path, 'rb') as f:
    parsed = plistlib.load(f)
assert len(parsed['WFWorkflowActions']) == len(actions)
assert parsed['WFWorkflowTypes'] == ['ActionExtension']
print(f'wrote {path}: {len(actions)} actions, re-parsed cleanly')
