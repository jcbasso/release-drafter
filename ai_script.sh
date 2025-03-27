#!/bin/bash

# Script to recursively combine all files in a folder and its subfolders
# into a single txt.final file,
# separating each file by name and ``` tags, with filename before ```.
# This is done to import to AI context.
# Recommended: Move astro, svelte, js, css, html, and other code files to
# a different folder without the node_modules/ and files to ignore.

# Check if a folder path is provided as an argument
if [ -z "$1" ]; then
  echo "Usage: $0 <source_folder_path>"
  echo "       Recursively combines all files in <source_folder_path> and its subfolders"
  echo "       into a single file named 'txt.final' in the current directory,"
  echo "       with each file's content enclosed in ``` tags,"
  echo "       and preceded by the filename *before* the ``` block."
  exit 1
fi

source_folder="$1"
output_file="code.txt"

# Check if the source folder exists and is a directory
if [ ! -d "$source_folder" ]; then
  echo "Error: Source folder '$source_folder' does not exist or is not a directory."
  exit 1
fi

# Ensure the output file is either created or truncated if it exists
> "$output_file"

echo "Recursively combining files from '$source_folder' into '$output_file'..."

# Recursively loop through all files in the source folder and subfolders
find "$source_folder" -type f -print0 | while IFS= read -r -d $'\0' item; do
  if [ -f "$item" ]; then
    # It's a file
    filename=$(basename "$item")  # Removed 'local' keyword

    # Append filename to the output file
    echo "$filename" >> "$output_file"

    # Append ``` to the output file
    echo '```' >> "$output_file"

    # Append the content of the file to the output file
    cat "$item" >> "$output_file"

    # Append ``` to the output file
    echo '```' >> "$output_file"

    # Add a newline to separate entries
    echo "" >> "$output_file"

    echo "Processed file: '$item'"
  fi
done

echo "All files recursively combined into '$output_file'"

exit 0
