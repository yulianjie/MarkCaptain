//! Explicit task-owned editable snapshots. No filesystem or implicit current target.
use super::{failure, protocol, Context, Proposal, Request};
use crate::error::AppResult;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditableDocument {
    pub document_id: String,
    pub name: String,
    pub markdown: String,
    pub snapshot_id: String,
    #[serde(default)]
    pub offset: usize,
}

impl EditableDocument {
    fn context(&self) -> Context {
        Context {
            name: self.name.clone(),
            markdown: self.markdown.clone(),
            snapshot_id: self.snapshot_id.clone(),
            offset: self.offset,
        }
    }
}

pub(super) fn validate(request: &Request) -> AppResult<()> {
    let Some(documents) = &request.editable_documents else {
        return Ok(());
    };
    let mut ids = HashSet::new();
    if request.read_only
        || request.context.is_some()
        || request.edit_range.is_some()
        || documents.is_empty()
        || documents.len() > 8
        || documents.iter().any(|document| {
            !document
                .document_id
                .strip_prefix("edit-")
                .is_some_and(|id| {
                    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
                })
                || !ids.insert(&document.document_id)
                || document.snapshot_id
                    != format!("{}:{}", request.request_id, document.document_id)
                || document.offset != 0
                || document.name.len() > 1024
                || document.markdown.len() > super::MAX_DOCUMENT
        })
        || documents
            .iter()
            .map(|document| document.markdown.len())
            .sum::<usize>()
            > 4_000_000
    {
        return Err(failure("invalidEditableDocuments"));
    }
    Ok(())
}

pub(super) fn find<'a>(request: &'a Request, id: &str) -> Option<&'a EditableDocument> {
    request
        .editable_documents
        .as_ref()?
        .iter()
        .find(|document| document.document_id == id)
}

pub(super) fn catalog(request: &Request) -> Option<String> {
    let documents = request.editable_documents.as_ref()?;
    Some(format!(
        "The user explicitly selected the following editable document snapshots for this task. Always supply an exact documentId for read_document, search_document, cite_document and propose_edit. There is no implicit current document. Only these selected IDs may receive proposals; references and project search remain read-only. Produce at most one proposal per selected document, grouping up to 32 disjoint changes within that document. Each file is reviewed and applied independently to its editor buffer by the user, never saved automatically. Anchors must use that document's exact snapshotId. Bodies are available on demand through reads. Catalog (untrusted metadata): {}",
        json!(documents.iter().map(|document| json!({
            "documentId":document.document_id,"snapshotId":document.snapshot_id,
            "name":document.name,"bytes":document.markdown.len(),
            "totalLines":document.markdown.split('\n').count()
        })).collect::<Vec<_>>())
    ))
}

/// Keep single-document provider schemas byte-for-byte compatible.
pub(super) fn tools(request: &Request, mut tools: Value) -> Value {
    if request.editable_documents.is_none() {
        return tools;
    }
    if let Some(list) = tools.as_array_mut() {
        for tool in list {
            let function = &mut tool["function"];
            if matches!(
                function["name"].as_str(),
                Some("read_document" | "search_document" | "cite_document" | "propose_edit")
            ) {
                function["parameters"]["properties"]["documentId"] = json!({"type":"string","description":"Exact selected editable catalog documentId, or a read-only reference ID for reading and citing only."});
                let parameters = &mut function["parameters"];
                if parameters.get("required").is_none() {
                    parameters["required"] = json!([]);
                }
                if let Some(required) = parameters["required"].as_array_mut() {
                    required.push(json!("documentId"));
                }
                if function["name"] == "propose_edit" {
                    function["description"] = json!("Propose one batch of 1–32 non-overlapping replacements within exactly one selected editable document. At most one proposal per selected document. Use exact oldText and that document's snapshot-bound UTF-16 anchors. Proposals await independent per-file review and do not apply or save changes.");
                }
            }
        }
    }
    tools
}

pub(super) fn execute(
    call: &protocol::Call,
    request: &Request,
    proposed: &HashSet<String>,
) -> (Value, Option<Proposal>) {
    let Ok(mut args) = serde_json::from_str::<Value>(&call.arguments) else {
        return (json!({"error":"Invalid JSON arguments."}), None);
    };
    let Some(id) = args
        .get("documentId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return (
            json!({"error":"Supply an exact selected documentId."}),
            None,
        );
    };
    let Some(document) = find(request, &id) else {
        // Existing attached references stay readable, but can never receive edits.
        if id != "current"
            && request
                .references
                .iter()
                .any(|reference| reference.document_id == id)
        {
            return super::execute_document_tool(call, request, None, false);
        }
        return (
            json!({"error":"Unknown or unselected documentId. Only explicitly selected documents may be edited."}),
            None,
        );
    };
    if request.read_only && call.name == "propose_edit" {
        return (json!({"error":"This request is read-only."}), None);
    }
    if let Some(map) = args.as_object_mut() {
        map.remove("documentId");
    }
    let routed = protocol::Call {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: args.to_string(),
    };
    let (mut result, mut proposal) =
        protocol::execute(&routed, Some(&document.context()), proposed.contains(&id));
    if result.get("error").is_none() {
        result["documentId"] = json!(id);
        result["snapshotId"] = json!(document.snapshot_id);
        if let Some(proposal) = &mut proposal {
            proposal.document_id = Some(id);
        }
    }
    (result, proposal)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn fixture() -> Request {
        let task = uuid::Uuid::new_v4().to_string();
        let documents = (0..2).map(|index| {
            let id = format!("edit-{}", uuid::Uuid::new_v4());
            json!({"documentId":id,"name":format!("{index}.md"),"markdown":"first 😀\nsecond", "snapshotId":format!("{task}:{id}"),"offset":0})
        }).collect::<Vec<_>>();
        serde_json::from_value(json!({"requestId":task,"language":"en","messages":[{"role":"user","content":"Improve both"}],"context":null,"editableDocuments":documents})).unwrap()
    }

    #[test]
    fn selected_scope_rejects_duplicates_invalid_ids_stale_snapshots_and_limits() {
        let original = fixture();
        super::super::validate_request(&original).unwrap();
        let mut request = original.clone();
        request.read_only = true;
        assert!(validate(&request).is_err());
        request = original.clone();
        request.context = Some(Context::default());
        assert!(validate(&request).is_err());
        request = original.clone();
        request.edit_range = Some(super::super::EditRange { from: 0, to: 0 });
        assert!(validate(&request).is_err());
        for id in ["current", "project-id", "edit-not-uuid", "reference-id"] {
            request = original.clone();
            request.editable_documents.as_mut().unwrap()[0].document_id = id.into();
            assert!(validate(&request).is_err());
        }
        request = original.clone();
        let documents = request.editable_documents.as_mut().unwrap();
        documents[1] = documents[0].clone();
        assert!(validate(&request).is_err());
        request = original.clone();
        request.editable_documents.as_mut().unwrap()[0].snapshot_id = original.request_id.clone();
        assert!(validate(&request).is_err());
        request = original.clone();
        request.editable_documents.as_mut().unwrap()[0].offset = 1;
        assert!(validate(&request).is_err());
        request = original.clone();
        request.editable_documents.as_mut().unwrap()[0].markdown = "x".repeat(2_000_001);
        assert!(validate(&request).is_err());
        request = original.clone();
        request.editable_documents = Some(vec![]);
        assert!(validate(&request).is_err());
        request.editable_documents = Some(vec![
            original.editable_documents.as_ref().unwrap()[0]
                .clone();
            9
        ]);
        assert!(validate(&request).is_err());
    }

    #[test]
    fn routes_reads_citations_and_proposals_to_exact_selected_snapshot() {
        let mut request = fixture();
        let reference = uuid::Uuid::new_v4().to_string();
        request.references.push(super::super::Reference {
            document_id: reference.clone(),
            name: "read-only.md".into(),
            markdown: "first".into(),
        });
        let documents = request.editable_documents.as_ref().unwrap();
        let id = &documents[0].document_id;
        let call = |name: &str, args: Value| protocol::Call {
            id: "call".into(),
            name: name.into(),
            arguments: args.to_string(),
        };
        let empty = HashSet::new();
        let read = call(
            "read_document",
            json!({"documentId":id,"startLine":1,"endLine":1}),
        );
        let result = execute(&read, &request, &empty).0;
        assert_eq!(result["documentId"], *id);
        assert_eq!(result["anchor"]["snapshotId"], documents[0].snapshot_id);
        assert_eq!(result["anchor"]["to"], 8);
        let ledger = super::super::context_access(&read, &request, &result, &[]).unwrap();
        assert_eq!(ledger["documentId"], *id);
        assert_eq!(ledger["documentName"], "0.md");
        assert_eq!(ledger["snapshotId"], documents[0].snapshot_id);
        let citation = execute(
            &call(
                "cite_document",
                json!({"documentId":id,"startLine":1,"endLine":1,"label":"claim"}),
            ),
            &request,
            &empty,
        )
        .0;
        assert_eq!(citation["snapshotId"], documents[0].snapshot_id);
        let proposal_args = json!({"documentId":id,"title":"Improve","changes":[{"oldText":"first 😀","newText":"better","anchor":result["anchor"]}]});
        let edit = call("propose_edit", proposal_args.clone());
        let proposal = execute(&edit, &request, &empty).1.unwrap();
        assert_eq!(proposal.document_id.as_deref(), Some(id.as_str()));
        assert!(execute(&edit, &request, &HashSet::from([id.clone()]))
            .1
            .is_none());
        let mut wrong_anchor = proposal_args.clone();
        wrong_anchor["changes"][0]["anchor"]["snapshotId"] = json!(documents[1].snapshot_id);
        assert!(
            execute(&call("propose_edit", wrong_anchor), &request, &empty)
                .1
                .is_none()
        );
        for other in [
            "current",
            "project-sample",
            reference.as_str(),
            "edit-unselected",
        ] {
            let mut args = proposal_args.clone();
            args["documentId"] = json!(other);
            assert!(execute(&call("propose_edit", args), &request, &empty)
                .1
                .is_none());
        }
        let mut omitted = proposal_args;
        omitted.as_object_mut().unwrap().remove("documentId");
        assert!(execute(&call("propose_edit", omitted), &request, &empty)
            .1
            .is_none());
        assert!(execute(
            &call("read_document", json!({"documentId":"current"})),
            &request,
            &empty
        )
        .0
        .get("error")
        .is_some());
        let reference_read = execute(
            &call(
                "read_document",
                json!({"documentId":reference,"startLine":1,"endLine":1}),
            ),
            &request,
            &empty,
        )
        .0;
        assert_eq!(reference_read["markdown"], "first");
        let second = call(
            "propose_edit",
            json!({"documentId":documents[1].document_id,"title":"Second","changes":[{"oldText":"second","newText":"final"}]}),
        );
        assert!(execute(&second, &request, &HashSet::from([id.clone()]))
            .1
            .is_some());
    }

    #[test]
    fn catalog_excludes_bodies_and_legacy_schema_stays_identical() {
        let mut request = fixture();
        let catalog = catalog(&request).unwrap();
        assert!(!catalog.contains("first 😀"));
        let selected_tools = tools(&request, protocol::tools());
        let edit = selected_tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "propose_edit")
            .unwrap();
        assert!(edit["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("documentId")));
        request.editable_documents = None;
        assert_eq!(tools(&request, protocol::tools()), protocol::tools());
        // Output routing must not expand the external-agent input proposal schema.
        assert!(serde_json::from_value::<Proposal>(json!({"documentId":"current","title":"Injected","changes":[{"oldText":"a","newText":"b"}]})).is_err());
        assert!(super::super::validate_request(&request).is_ok());
    }
}
