/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	CompletionList,
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	IConnection
} from 'vscode-languageserver';
import { getLanguageModes, Hover, LanguageModes, getLanguageService, TextDocumentIdentifier, Definition, Location } from './languageModes';

import * as ts from 'typescript';

let languageModes: LanguageModes;

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection: IConnection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;
	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// supports code completion proposals
			hoverProvider: true,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	result.capabilities.definitionProvider = true;
	return result;
});

connection.onDefinition((params: TextDocumentPositionParams): Location[] => {
	let locations: Location[] = [];

	const de = declarationMap.get(currentHover);
	if(de) {
		locations.push({
			uri: params.textDocument.uri,
			range: {
				start: { line: de.line, character: de.pos },
				end: { line: de.line, character: 0 }
			}
		});
	}

	return locations;
  });

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});


type DeclarationItem = {
	type: 'var' | 'function' | 'class' | 'member';
	pos: number;
	end: number;
	line: number,
	escapedText: string;
	children?: DeclarationItem[]
};
const declarationMap: Map<string, DeclarationItem> = new Map();

let currentHover: string;

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	// validateTextDocument(change.document);
	let fileContent = change.document.getText();
	const r1 = getLanguageService().parseHTMLDocument(change.document).roots[0];
	const start = (r1.startTagEnd || 0);
	const end = (r1.endTagStart || 0);
	const text = change.document.getText().substring(start, end);
	const sourceFile: ts.SourceFile = ts.createSourceFile('ast.ts', text, ts.ScriptTarget.ES2020);
	sourceFile.statements.forEach((node: ts.Statement) => {
		let parse;
		if(ts.isFunctionDeclaration(node)) {
			parse = ts.getParseTreeNode<ts.FunctionDeclaration>(node);
			if(parse?.name?.escapedText) {
				declarationMap.set(parse?.name?.escapedText, {
					type: 'function',
					pos: parse.name.pos,
					end: parse.name.end,
					line: text.substring(0, parse.name.end).split("\n").length -1,
					escapedText: parse?.name?.escapedText
				});
			}
		} else if(ts.isVariableStatement(node)) {
			parse = ts.getParseTreeNode<ts.VariableStatement>(node as ts.VariableStatement);
			if(parse) {
				const escapedText = (parse.declarationList.declarations[0].name as ts.Identifier).escapedText as string;
				declarationMap.set(escapedText, {
					type: 'var',
					pos: parse.declarationList.declarations[0].pos,
					end: parse.declarationList.declarations[0].end,
					line: text.substring(0, parse.end).split("\n").length -1,
					escapedText: escapedText
				});
			}
		} else if(ts.isClassDeclaration(node)) {
			declarationMap.set(node.name?.escapedText as string, {
				type: 'class',
				pos: node.name?.pos as number,
				end: node.name?.end as number,
				line: text.substring(0, node.name?.end).split("\n").length -1,
				escapedText: node.name?.escapedText as string,
				children: node.members.map(m => {
					return {
						type: 'member',
						pos: m.name?.pos as number,
						end: m.name?.end as number,
						line: text.substring(0, m.name?.end).split("\n").length -1,
						escapedText: (m?.name as ts.Identifier).escapedText as string
					};
				})
			});
		}
	});
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /\b[A-Z]{2,}\b/g;
	let m: RegExpExecArray | null;

	let problems = 0;
	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
		problems++;
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			message: `${m[0]} is all uppercase.`,
			source: 'ex'
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Spelling matters'
				},
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Particularly for names'
				}
			];
		}
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
// connection.onCompletion(
// 	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
// 		// The pass parameter contains the position of the text document in
// 		// which code complete got requested. For the example we ignore this
// 		// info and always provide the same completion items.
// 		return [
// 			{
// 				label: 'TypeScript',
// 				kind: CompletionItemKind.Text,
// 				data: 1
// 			},
// 			{
// 				label: 'JavaScript',
// 				kind: CompletionItemKind.Text,
// 				data: 3
// 			}
// 		];
// 	}
// );

connection.onCompletion(async (textDocumentPosition, token) => {
	const document = documents.get(textDocumentPosition.textDocument.uri);
	if (!document) {
		return null;
	}

	if(languageModes) {
		const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
		if (!mode || !mode.doComplete) {
			return CompletionList.create();
		}
		const doComplete = mode.doComplete!;
	
		return doComplete(document, textDocumentPosition.position);
	}
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

function getWord(text: string, index: number) {
    const first = text.lastIndexOf(' ', index);
    const last = text.indexOf(' ', index);
    return text.substring(first !== -1 ? first : 0, last !== -1 ? last : text.length - 1);
}

connection.onHover(({ textDocument, position }): Hover | undefined => {
    const document = documents.get(textDocument.uri);
    const start = {
      line: position.line,
      character: 0,
    };
    const end = {
      line: position.line + 1,
      character: 0,
    };
	if(document)  {
		const text = document.getText({ start, end });
		const index = document.offsetAt(position) - document.offsetAt(start);
		const word = getWord(text, index).trim();
	
		if (word) {
			currentHover = word;
			return {
				contents: {
					kind: 'markdown',
					value: `Current word: ${word} ${declarationMap.get(word)?.pos} ${declarationMap.get(word)?.end}`,
				},
			};
		}
	}

	return undefined;
});


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();