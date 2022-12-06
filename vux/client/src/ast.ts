import * as ts from 'typescript';

const source = `class abc {
    a = 10;
}
class ac {
    a = 10;
}`;

const astResult = ts.createSourceFile("d", source, ts.ScriptTarget.ES2020, /*setParentNodes*/ true);

console.dir(astResult.flags);